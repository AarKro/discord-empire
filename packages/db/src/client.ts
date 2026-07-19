import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Sql = ReturnType<typeof postgres>;
export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DbHandle {
  db: Db;
  sql: Sql;
  close: () => Promise<void>;
}

/**
 * Open a Postgres connection + Drizzle handle.
 * `max: 1` is only appropriate for scripts/tests; services should raise it.
 */
export function openDb(url: string, opts: { max?: number } = {}): DbHandle {
  const sql = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}

/**
 * Wrap a value for a jsonb column. postgres-js's `sql.json` types its argument
 * as a strict JSON value; our payloads are `Record<string, unknown>` (validated
 * upstream by Zod), so this centralizes the one necessary cast.
 */
export function jsonParam(sql: Sql, value: unknown): ReturnType<Sql["json"]> {
  return sql.json(value as Parameters<Sql["json"]>[0]);
}

export { schema };
