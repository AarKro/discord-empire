/**
 * Unit tests for the hooded stranger's /approach gates (§5.4/§11). Faked sql +
 * bus + LLM client assert the three cost gates and the record/emit behaviour:
 * presence, once-per-visit, and the hourly circuit breaker — plus that
 * `dialogue.generated` is emitted ONLY on a real API call while
 * `dialogue.approached` marks every spent visit.
 */
import { describe, it, expect, afterEach } from "vitest";
import { approachStranger } from "../src/stranger.js";
import type { MessagesClient } from "../src/llm.js";
import type { ApproachDeps } from "../src/stranger.js";

interface World {
  guild: string | null; // where the stranger stands (npcs.state.guild)
  playerGuild: string | null; // player's position_guild_id
  approachedCount: number; // dialogue.approached rows this window
  generatedCount: number; // dialogue.generated rows this hour
  published: { type: string; payload?: Record<string, unknown> }[];
}

function makeDeps(world: World): ApproachDeps {
  const sql = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("FROM npcs")) return Promise.resolve([{ state: { guild: world.guild } }]);
    if (q.includes("FROM players")) return Promise.resolve([{ position_guild_id: world.playerGuild }]);
    if (q.includes("dialogue.approached")) return Promise.resolve([{ n: world.approachedCount }]);
    if (q.includes("dialogue.generated")) return Promise.resolve([{ n: world.generatedCount }]);
    return Promise.resolve([]);
  };
  return {
    sql: sql as unknown as ApproachDeps["sql"],
    bus: { publish: async (input: { type: string; payload?: Record<string, unknown> }) => { world.published.push(input); return undefined; } } as unknown as ApproachDeps["bus"],
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child() { return this; } } as unknown as ApproachDeps["logger"],
    npcId: "secret_merchant",
  };
}

const PERSONA = { nickname: "A Hooded Stranger", localeFlavor: "harbor" };
const okClient: MessagesClient = { messages: { create: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "The gulls know your name." }] }) } };

function base(): World {
  return { guild: "g1", playerGuild: "g1", approachedCount: 0, generatedCount: 0, published: [] };
}

afterEach(() => {
  delete process.env.DIALOGUE_MAX_PER_HOUR;
  delete process.env.ANTHROPIC_API_KEY;
});

describe("approachStranger (§5.4/§11)", () => {
  it("generates a line when present + first visit + under cap, emitting both events", async () => {
    const world = base();
    const reply = await approachStranger(makeDeps(world), "u1", PERSONA, okClient);
    expect(reply).toContain("The gulls know your name.");
    expect(world.published.map((e) => e.type).sort()).toEqual(["dialogue.approached", "dialogue.generated"]);
    expect(world.published.find((e) => e.type === "dialogue.approached")!.payload!.generated).toBe(true);
  });

  it("gate 1 — no line when the stranger is not present (in transit)", async () => {
    const world = { ...base(), guild: null };
    const reply = await approachStranger(makeDeps(world), "u1", PERSONA, okClient);
    expect(reply).toMatch(/no stranger/i);
    expect(world.published).toHaveLength(0);
  });

  it("gate 1 — no line when the player is on a different continent", async () => {
    const world = { ...base(), playerGuild: "g2" };
    const reply = await approachStranger(makeDeps(world), "u1", PERSONA, okClient);
    expect(reply).toMatch(/no such presence/i);
    expect(world.published).toHaveLength(0);
  });

  it("gate 2 — blocks a second approach in the same visit", async () => {
    const world = { ...base(), approachedCount: 1 };
    const reply = await approachStranger(makeDeps(world), "u1", PERSONA, okClient);
    expect(reply).toMatch(/already spoken/i);
    expect(world.published).toHaveLength(0);
  });

  it("gate 3 — over the hourly cap falls back to an authored line, no generated event", async () => {
    process.env.DIALOGUE_MAX_PER_HOUR = "5";
    const world = { ...base(), generatedCount: 5 };
    const reply = await approachStranger(makeDeps(world), "u1", PERSONA, okClient);
    expect(reply).not.toContain("The gulls know your name.");
    expect(reply).toContain("hooded stranger leans close");
    expect(world.published.map((e) => e.type)).toEqual(["dialogue.approached"]);
    expect(world.published[0]!.payload!.generated).toBe(false);
  });

  it("no key + no client falls back to an authored line (spends the visit)", async () => {
    const world = base();
    const reply = await approachStranger(makeDeps(world), "u1", PERSONA);
    expect(reply).toContain("hooded stranger leans close");
    expect(world.published.map((e) => e.type)).toEqual(["dialogue.approached"]);
    expect(world.published[0]!.payload!.generated).toBe(false);
  });
});
