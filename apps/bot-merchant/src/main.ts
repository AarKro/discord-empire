/**
 * Merchant — reference bot #1 (framework spec §4 roster, §10 validation path).
 *
 * Capabilities (see manifests/merchant.yaml): trade, topology, stall, dialogue,
 * presence.voice, voicelines, ambient.chatter, render. Stands in the Bazaar with
 * a stall embed; Enter → the aldric_haggle workflow renders a private-thread
 * haggle against a hidden, reputation-adjusted floor → atomic purchase (via
 * `trade`) → receipt; wanders between voice channels on the hour.
 *
 * The generic runner (core's runBot) owns the whole lifecycle; this entrypoint
 * only supplies the manifest and the code-only config that can't live in YAML —
 * the voiceline and ambient-chatter trigger maps.
 */
import { runBot, rootLogger } from "@empire/core";

runBot({
  manifest: "manifests/merchant.yaml",
  configs: {
    voicelines: { triggers: { "trade.completed": ["sale_1.opus"], "npc.arrived": ["greet_1.opus"] } },
    "ambient.chatter": {
      reactions: {
        "world.rumor": ["Did you hear...?", "Word around the stalls:", "A little bird whispers:", "They say"],
      },
    },
  },
}).catch((err) => {
  rootLogger.error({ err }, "merchant crashed");
  process.exit(1);
});
