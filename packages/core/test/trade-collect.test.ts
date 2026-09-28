/**
 * /collect is a round-trip into `trade` (§2.4, invariant #2: only `trade`
 * writes the ledger). What's pinned: it answers the waiting command on its
 * correlation, and a collect addressed to another bot is left alone — the bus is
 * broadcast, and a second bot banking the same stores would double-pay.
 */
import { describe, it, expect } from "vitest";
import { tradeCapability } from "../src/capabilities/trade.js";
import type { BusEvent } from "../src/events/bus.js";
import type { CapabilityContext } from "../src/runtime/capability.js";

function makeCtx(published: { type: string; correlationId?: string | null; payload?: Record<string, unknown> }[], collected: { n: number }) {
  const tx = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const q = strings.join("?");
    if (q.includes("SELECT now()")) return Promise.resolve([{ now: new Date("2026-09-28T12:00:00Z") }]);
    if (q.includes("FROM build_queue")) collected.n += 1;
    return Promise.resolve([]);
  };
  const sql = Object.assign(() => Promise.resolve([]), { begin: async (fn: (t: unknown) => unknown) => fn(tx) });
  const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => log };
  return {
    bot: "builder",
    sql,
    bus: { publish: async (e: (typeof published)[number]) => void published.push(e) },
    logger: log,
    config: {},
  } as unknown as CapabilityContext;
}

const evt = (subject: string): BusEvent =>
  ({
    dbId: "1", eventId: "e", type: "collect.requested", ts: "", guildId: "g1",
    actor: { kind: "player", id: "p1" }, subject: { kind: "npc", id: subject }, payload: {}, correlationId: "cmd_1",
  }) as BusEvent;

describe("trade collect.requested (§2.4)", () => {
  it("banks and answers the waiting /collect on its correlation", async () => {
    const published: Parameters<typeof makeCtx>[0] = [];
    const collected = { n: 0 };
    await tradeCapability().handle!(evt("builder"), makeCtx(published, collected));
    expect(collected.n).toBe(1);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ type: "command.reply", correlationId: "cmd_1" });
    expect(String(published[0]!.payload!.message)).toContain("Nothing on your land produces yet");
  });

  it("ignores a collect addressed to another bot", async () => {
    const published: Parameters<typeof makeCtx>[0] = [];
    const collected = { n: 0 };
    await tradeCapability().handle!(evt("warden"), makeCtx(published, collected));
    expect(collected.n).toBe(0);
    expect(published).toEqual([]);
  });
});
