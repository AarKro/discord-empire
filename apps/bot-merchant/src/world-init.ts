/**
 * `pnpm world:init` — one-shot dev-world bootstrap (see core/src/bootstrap.ts).
 * Reads the same env/content as the merchant bot; safe to rerun any time.
 */
import { join } from "node:path";
import { loadContentFile, Manifest, Shop, Continents } from "@empire/content-schemas";
import { bootstrapWorld, rootLogger } from "@empire/core";
import { openDb } from "@empire/db";

const CONTENT_DIR = process.env.CONTENT_DIR ?? "content";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");

  const manifest = loadContentFile(Manifest, join(CONTENT_DIR, "manifests/merchant.yaml"));
  const continents = loadContentFile(Continents, join(CONTENT_DIR, "continents.yaml"));
  const shop = loadContentFile(Shop, join(CONTENT_DIR, manifest.content?.shop ?? "shops/aldric.yaml"));

  const token = process.env[manifest.token_env];
  if (!token) throw new Error(`${manifest.token_env} is required`);

  const { sql, close } = openDb(url);
  try {
    await bootstrapWorld({
      token,
      sql,
      continents,
      npcId: manifest.id,
      shop,
      // Iteration 1 seeds the Builder's cost-sink NPC + build permit stock and
      // the buildable catalog here too, so a single world:init covers both
      // reference bots (§10). The merchant bot has Manage Channels, so it runs it.
      builderId: "builder",
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
