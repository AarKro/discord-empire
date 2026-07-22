/**
 * The dialogue-thread persistence round-trip against a REAL Postgres (opt-in on
 * TEST_DATABASE_URL, like the ledger suite). render keeps each player's open
 * conversation thread in npcs.state so a mid-conversation restart can still post
 * to it; this proves the jsonb save / load / remove SQL (the `#-` path-delete in
 * particular) actually works — the gateway wiring is a dev-server concern.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openDb, type DbHandle } from "@empire/db";
import { loadThreadId, saveThreadId, removeThreadId } from "../src/capabilities/render.js";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

let h: DbHandle;

suite("dialogue thread persistence (npcs.state)", () => {
  beforeAll(async () => {
    h = openDb(url!, { max: 4 });
    await h.sql`CREATE TABLE IF NOT EXISTS npcs (id text PRIMARY KEY, kind text NOT NULL DEFAULT 'merchant', state jsonb NOT NULL DEFAULT '{}')`;
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await h.sql`TRUNCATE npcs`;
    await h.sql`INSERT INTO npcs (id) VALUES ('merchant')`;
  });

  it("saves, loads, and removes a player's thread id without disturbing others", async () => {
    expect(await loadThreadId(h.sql, "merchant", "p1")).toBe(null);

    await saveThreadId(h.sql, "merchant", "p1", "thread_1");
    await saveThreadId(h.sql, "merchant", "p2", "thread_2");
    expect(await loadThreadId(h.sql, "merchant", "p1")).toBe("thread_1");
    expect(await loadThreadId(h.sql, "merchant", "p2")).toBe("thread_2");

    // Simulate the restart path: a fresh read still finds the persisted thread.
    const [{ state }] = await h.sql<{ state: { dialogue_threads: Record<string, string> } }[]>`SELECT state FROM npcs WHERE id = 'merchant'`;
    expect(state.dialogue_threads).toEqual({ p1: "thread_1", p2: "thread_2" });

    // Closing p1's conversation drops only p1 (the `#-` path delete).
    await removeThreadId(h.sql, "merchant", "p1");
    expect(await loadThreadId(h.sql, "merchant", "p1")).toBe(null);
    expect(await loadThreadId(h.sql, "merchant", "p2")).toBe("thread_2");
  });

  it("coexists with stall_messages in the same npcs.state blob", async () => {
    await h.sql`UPDATE npcs SET state = jsonb_set(state, '{stall_messages}', '{"g1":"msg_1"}'::jsonb) WHERE id = 'merchant'`;
    await saveThreadId(h.sql, "merchant", "p1", "thread_1");

    const [{ state }] = await h.sql<{ state: Record<string, unknown> }[]>`SELECT state FROM npcs WHERE id = 'merchant'`;
    expect(state.stall_messages).toEqual({ g1: "msg_1" }); // untouched
    expect(state.dialogue_threads).toEqual({ p1: "thread_1" });
  });
});
