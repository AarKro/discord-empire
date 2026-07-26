/**
 * Migration-state precondition check.
 *
 * Integration suites deliberately do NOT create schema. They used to: every
 * suite carried its own `ensureSchema()` of `CREATE TABLE IF NOT EXISTS`
 * statements, which meant the schema was authored by hand in ten places and
 * drifted from schema.ts independently — the direct cause of a dev database
 * that was neither at migration 0000 nor at HEAD, and of `db:migrate` failing
 * on an already-pushed column.
 *
 * So tests assert instead. A suite running against an unmigrated database
 * should fail immediately, naming the fix, rather than 40 lines later with a
 * confusing missing-column error — or worse, silently passing against a
 * hand-rolled schema that no longer matches production.
 */
import { readFile } from "node:fs/promises";
import type { Sql } from "./client.js";

/** Shape of drizzle-kit's `migrations/meta/_journal.json`. */
interface Journal {
  entries: { idx: number; tag: string }[];
}

const JOURNAL_URL = new URL("../migrations/meta/_journal.json", import.meta.url);

/** The migrations drizzle-kit expects to exist, newest last. */
async function expectedMigrations(): Promise<string[]> {
  const journal = JSON.parse(await readFile(JOURNAL_URL, "utf8")) as Journal;
  return [...journal.entries].sort((a, b) => a.idx - b.idx).map((e) => e.tag);
}

/**
 * Throw unless every migration in the journal has been applied to this database.
 *
 * Drizzle records applied migrations in `drizzle.__drizzle_migrations` by hash,
 * not tag, so we compare counts — enough to catch the cases that actually bite
 * (nothing applied, or a chain that stopped part-way).
 */
export async function assertMigrated(sql: Sql, hint = "pnpm db:migrate:test"): Promise<void> {
  const expected = await expectedMigrations();

  const [present] = await sql<{ ok: boolean }[]>`
    SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS ok
  `;
  if (!present?.ok) {
    throw new Error(
      `Database has no migration ledger — it has never been migrated. Run \`${hint}\` first. ` +
        `(Integration tests do not create schema; see packages/db/src/migration-state.ts.)`,
    );
  }

  const [applied] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations
  `;
  const n = applied?.n ?? 0;
  if (n < expected.length) {
    throw new Error(
      `Database is behind: ${n} of ${expected.length} migrations applied ` +
        `(newest expected: ${expected[expected.length - 1]}). Run \`${hint}\`.`,
    );
  }
}
