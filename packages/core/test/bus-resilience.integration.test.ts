/**
 * Integration suite for the event bus's failure handling (§3) against a REAL
 * Postgres — LISTEN/NOTIFY and the cursor table can't be faked meaningfully.
 *
 *   pnpm test:integration            # after `docker compose up -d postgres`
 *
 * The property under test is that ONE bad event cannot wedge a consumer. The bus
 * used to rethrow a failing handler, which was doubly fatal: during replay it
 * rejected subscribe() (every bot entrypoint turns that into process.exit(1)),
 * and because the cursor only advanced past a handled event, the same event
 * replayed on the next boot and crashed again — a permanent crash loop from a
 * single revoked Discord permission. Delivery must continue and the cursor must
 * advance regardless.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openDb, type DbHandle, assertMigrated } from "@empire/db";
import { EventBus } from "../src/events/bus.js";
import { rootLogger } from "../src/logger.js";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

let h: DbHandle;

/** Wait until `check` holds, or fail loudly — NOTIFY delivery is asynchronous. */
async function eventually(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(check()).toBe(true);
}

suite("event bus resilience (§3)", () => {
  beforeAll(async () => {
    h = openDb(url!, { max: 4 });
    await assertMigrated(h.sql);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await h.sql`TRUNCATE events, bus_cursors RESTART IDENTITY CASCADE`;
  });

  it("delivers a transactional publish only if its transaction commits (§3 transactional emit)", async () => {
    // combat.resolve relies on this: grants emitted inside the resolve
    // transaction must vanish with it when any later statement fails.
    const bus = new EventBus(h.sql, "resilience-tx", rootLogger);
    const seen: string[] = [];
    await bus.subscribe((evt) => {
      seen.push(evt.type);
    });

    await expect(
      h.sql.begin(async (tx) => {
        await bus.publish({ type: "rolled_back" }, tx);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    await h.sql.begin(async (tx) => {
      await bus.publish({ type: "committed" }, tx);
    });

    await eventually(() => seen.includes("committed"));
    expect(seen).toEqual(["committed"]);
    const rows = await h.sql<{ type: string }[]>`SELECT type FROM events ORDER BY id`;
    expect(rows.map((r) => r.type)).toEqual(["committed"]);

    await bus.close();
  });

  it("keeps delivering after a handler throws, and advances the cursor past it", async () => {
    const bus = new EventBus(h.sql, "resilience-live", rootLogger);
    const seen: string[] = [];
    await bus.subscribe((evt) => {
      seen.push(evt.type);
      if (evt.type === "boom") throw new Error("handler blew up");
    });

    await bus.publish({ type: "boom" });
    await bus.publish({ type: "after" });

    // The failing event did not stop the one behind it.
    await eventually(() => seen.includes("after"));
    expect(seen).toEqual(["boom", "after"]);

    // …and the cursor moved past BOTH, so neither replays on the next boot.
    const [{ max }] = await h.sql<{ max: string }[]>`SELECT MAX(id)::text AS max FROM events`;
    const [cursor] = await h.sql<{ last_processed_id: string }[]>`
      SELECT last_processed_id::text FROM bus_cursors WHERE consumer = 'resilience-live'
    `;
    expect(cursor!.last_processed_id).toBe(max);

    await bus.close();
  });

  it("does not reject subscribe() when a handler throws during replay", async () => {
    // A poison event committed BEFORE the consumer ever starts: the boot-time
    // replay must survive it rather than taking the process down.
    const seeder = new EventBus(h.sql, "resilience-seeder", rootLogger);
    await seeder.publish({ type: "boom" });
    await seeder.publish({ type: "after" });

    const bus = new EventBus(h.sql, "resilience-replay", rootLogger);
    const seen: string[] = [];
    await expect(
      bus.subscribe((evt) => {
        seen.push(evt.type);
        if (evt.type === "boom") throw new Error("handler blew up");
      }),
    ).resolves.toBeUndefined();

    expect(seen).toEqual(["boom", "after"]);
    await bus.close();
  });

  /**
   * Notifications are delivered concurrently, and the bus used to fetch the
   * notified row per notification. Whichever async read resolved first was
   * dispatched first, so a later event could advance the cursor past an earlier
   * one — which `dispatch` then silently discarded as already-seen. A burst must
   * arrive complete and in id order.
   */
  it("delivers a burst of events in id order, losing none", async () => {
    const bus = new EventBus(h.sql, "resilience-burst", rootLogger);
    const seen: number[] = [];
    await bus.subscribe((evt) => { seen.push(Number(evt.dbId)); });

    const count = 25;
    await Promise.all(
      Array.from({ length: count }, (_, i) => bus.publish({ type: "burst", payload: { i } })),
    );

    await eventually(() => seen.length === count, 5000);
    expect(seen.length).toBe(count);
    expect(seen).toEqual([...seen].sort((a, b) => a - b)); // strictly id-ordered
    expect(new Set(seen).size).toBe(count); // no duplicates

    await bus.close();
  });

  it("a restarted consumer does not re-deliver the event its handler failed on", async () => {
    const seeder = new EventBus(h.sql, "resilience-seeder-2", rootLogger);
    await seeder.publish({ type: "boom" });

    const first = new EventBus(h.sql, "resilience-restart", rootLogger);
    await first.subscribe(() => { throw new Error("handler blew up"); });
    await first.close();

    // Same consumer name = same cursor. The poison event is behind us now.
    const second = new EventBus(h.sql, "resilience-restart", rootLogger);
    const seen: string[] = [];
    await second.subscribe((evt) => { seen.push(evt.type); });
    expect(seen).toEqual([]);
    await second.close();
  });
});
