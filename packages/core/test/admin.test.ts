/**
 * Unit tests for the ops read views (§9): buildEventsEmbed + buildWorkflowsEmbed
 * render the newest rows and show a clear empty/filtered state. The query is
 * faked — we assert the SQL→embed shaping, not Postgres.
 */
import { describe, it, expect } from "vitest";
import { buildEventsEmbed, buildWorkflowsEmbed } from "../src/admin.js";
import type { Sql } from "@empire/db";

function fakeSql(rows: unknown[]): Sql {
  return (() => Promise.resolve(rows)) as unknown as Sql;
}

describe("buildEventsEmbed (§9)", () => {
  it("renders recent events with id, type and actor", async () => {
    const embed = await buildEventsEmbed(fakeSql([
      { id: 42, type: "trade.completed", actor_kind: "player", actor_id: "u1", correlation_id: "wf_1", ts: "" },
      { id: 41, type: "world.announce", actor_kind: "world", actor_id: "auction", correlation_id: null, ts: "" },
    ]));
    const json = embed.toJSON();
    expect(json.title).toContain("Event log");
    expect(json.description).toContain("#42");
    expect(json.description).toContain("trade.completed");
    expect(json.description).toContain("player:u1");
    expect(json.description).toContain("wf_1");
  });

  it("shows a filtered empty-state", async () => {
    const embed = await buildEventsEmbed(fakeSql([]), { type: "nope.event" });
    expect(embed.toJSON().description).toContain("type=nope.event");
  });
});

describe("buildWorkflowsEmbed (§9)", () => {
  it("renders instances with workflow id, scope and state", async () => {
    const embed = await buildWorkflowsEmbed(fakeSql([
      { id: "wfi_1", workflow_id: "player_build", scope: "player", scope_key: "u1", state: "building", status: "active", timer_at: null },
    ]));
    const json = embed.toJSON();
    expect(json.title).toContain("Workflow");
    expect(json.description).toContain("player_build");
    expect(json.description).toContain("player:u1");
    expect(json.description).toContain("building");
  });

  it("shows an empty-state when nothing is running", async () => {
    const embed = await buildWorkflowsEmbed(fakeSql([]));
    expect(embed.toJSON().description).toContain("No workflow instances");
  });
});
