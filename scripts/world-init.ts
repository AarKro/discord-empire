/**
 * `pnpm world:init` / `pnpm start`'s world step — one-shot dev-world bootstrap
 * (see packages/core/src/bootstrap.ts). Decoupled from any bot app: it just
 * needs a Discord token with Manage Channels/Roles, and reuses the merchant's
 * token (MERCHANT_TOKEN) since that bot already has those perms.
 *
 * Idempotent — safe to rerun (reuses channels, never restocks). By default it
 * SKIPS when the world is already seeded (so `pnpm start` stays fast); pass
 * `--force` to re-run bootstrap after adding new world content.
 */
import { join } from "node:path";
import { loadContentFile, Manifest, Shop, Continents, Districts } from "@empire/content-schemas";
import { bootstrapWorld, rootLogger } from "@empire/core";
import { openDb } from "@empire/db";

const CONTENT_DIR = process.env.CONTENT_DIR ?? "content";
const force = process.argv.includes("--force");

/** Has the world ever been bootstrapped? bootstrap seeds a `locations` row per
 * guild, so any row means yes. A missing table (pre-migrate) counts as no. */
async function alreadySeeded(sql: ReturnType<typeof openDb>["sql"]): Promise<boolean> {
  try {
    const rows = await sql`SELECT 1 FROM locations LIMIT 1`;
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const manifest = loadContentFile(Manifest, join(CONTENT_DIR, "manifests/merchant.yaml"));
  const continents = loadContentFile(Continents, join(CONTENT_DIR, "continents.yaml"));
  const districts = loadContentFile(Districts, join(CONTENT_DIR, "districts.yaml"));
  const shop = loadContentFile(Shop, join(CONTENT_DIR, manifest.content?.shop ?? "shops/aldric.yaml"));
  // Seed the builder's cost-sink NPC under its real manifest id (the builder bot
  // trades as its manifest.id), so the two can never drift out of sync.
  const builderManifest = loadContentFile(Manifest, join(CONTENT_DIR, "manifests/builder.yaml"));

  // Bootstrap needs a token with Manage Channels/Roles; the merchant's has them.
  const token = process.env[manifest.token_env];
  if (!token) throw new Error(`${manifest.token_env} is required`);

  const { sql, close } = openDb(url);
  try {
    if (!force && (await alreadySeeded(sql))) {
      rootLogger.info("world already initialized — skipping (use --force to re-seed)");
      return;
    }
    await bootstrapWorld({
      token,
      sql,
      continents,
      districts,
      npcId: manifest.id,
      shop,
      // Iteration 1 seeds the Builder's cost-sink NPC + build permit stock and
      // the buildable catalog here too, so a single world:init covers both
      // reference bots (§10). The merchant token has Manage Channels, so it runs it.
      builderId: builderManifest.id,
      logger: rootLogger,
    });
  } finally {
    await close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    rootLogger.error({ err }, "world:init failed");
    process.exit(1);
  });
