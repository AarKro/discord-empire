/**
 * Secret merchant — reference traveling NPC (framework spec §9). A hooded stranger
 * that walks the continent ring: present in exactly one continent at a time,
 * leaving one guild's voice and reappearing on a neighbour (see manifests/
 * secret_merchant.yaml + workflows/secret_merchant.yaml).
 *
 * The generic runner (core's runBot) owns the whole lifecycle; the `travel`
 * capability is fully data-driven (its ring comes from continents.yaml), so this
 * entrypoint only names the manifest — no code-only config.
 */
import { runBot, rootLogger } from "@empire/core";

runBot({ manifest: "manifests/secret_merchant.yaml" }).catch((err) => {
  rootLogger.error({ err }, "secret merchant crashed");
  process.exit(1);
});
