/**
 * Land privacy (§2.4) — the overwrite rule, pure. Applying it is Discord's job
 * and is exercised on the dev servers (the tech spec rules out Discord mocking);
 * what's pinned here is WHO may do WHAT.
 */
import { describe, it, expect } from "vitest";
import { OverwriteType, PermissionFlagsBits as P } from "discord.js";
import { plotOverwrites } from "../src/gateway/plot-privacy.js";

const base = { everyoneRoleId: "guild1", ownerId: "owner1", botRoleIds: ["botA", "botB"] };

describe("plotOverwrites (§2.4)", () => {
  it("hides the plot from everyone", () => {
    const everyone = plotOverwrites({ ...base, kind: "text" }).find((o) => o.id === "guild1")!;
    expect(everyone.type).toBe(OverwriteType.Role);
    expect(everyone.deny).toContain(P.ViewChannel);
  });

  it("lets the owner read and write their estate text channel", () => {
    const owner = plotOverwrites({ ...base, kind: "text" }).find((o) => o.id === "owner1")!;
    expect(owner.type).toBe(OverwriteType.Member);
    expect(owner.allow).toEqual(expect.arrayContaining([P.ViewChannel, P.SendMessages, P.ReadMessageHistory]));
  });

  it("lets the owner watch their voice channel but never join it (§5.1 voice is a map)", () => {
    const owner = plotOverwrites({ ...base, kind: "voice" }).find((o) => o.id === "owner1")!;
    expect(owner.allow).toEqual([P.ViewChannel]);
    expect(owner.deny).toEqual([P.Connect]);
  });

  it("gives every bot role what it needs to run the estate", () => {
    const text = plotOverwrites({ ...base, kind: "text" });
    for (const id of ["botA", "botB"]) {
      const bot = text.find((o) => o.id === id)!;
      expect(bot.allow).toEqual(expect.arrayContaining([P.ViewChannel, P.SendMessages, P.CreatePrivateThreads, P.ManageThreads]));
    }
    // NPCs visit in voice.
    expect(plotOverwrites({ ...base, kind: "voice" }).find((o) => o.id === "botA")!.allow).toContain(P.Connect);
  });

  it("still hides the plot when the owner has left the guild", () => {
    const overwrites = plotOverwrites({ ...base, ownerId: null, kind: "text" });
    expect(overwrites.some((o) => o.type === OverwriteType.Member)).toBe(false);
    expect(overwrites.find((o) => o.id === "guild1")!.deny).toContain(P.ViewChannel);
  });

  it("grants nobody else anything", () => {
    const ids = plotOverwrites({ ...base, kind: "text" }).map((o) => o.id);
    expect(ids.sort()).toEqual(["botA", "botB", "guild1", "owner1"]);
  });
});
