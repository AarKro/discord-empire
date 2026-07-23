/**
 * Boot-time content validation, proven against the REAL YAML shipped in
 * content/ (framework spec §8 "validated at boot"). Guards the §10 DoD line
 * "a new shop or dialogue variant ships by editing YAML only" — a malformed
 * edit fails here (and at boot) rather than at runtime.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadContentFile,
  Manifest,
  Shop,
  Workflow,
  Schedule,
  Continents,
  Districts,
  Instances,
} from "../src/index.js";

const CONTENT = join(dirname(fileURLToPath(import.meta.url)), "../../../content");

// The shipped YAML references dev guild IDs via ${VAR} substitution; supply
// stand-ins so the files validate without a real .env (as they do at boot).
process.env.GUILD_CONTINENT_ONE ??= "guild_111111";
process.env.GUILD_CONTINENT_TWO ??= "guild_222222";

describe("shipped content validates against schemas", () => {
  it("manifests", () => {
    const merchant = loadContentFile(Manifest, join(CONTENT, "manifests/merchant.yaml"));
    const builder = loadContentFile(Manifest, join(CONTENT, "manifests/builder.yaml"));
    expect(merchant.id).toBe("merchant");
    expect(builder.capabilities).toContain("land");
    // §10 DoD: distinct personas per guild.
    expect(Object.keys(merchant.personas).length).toBeGreaterThanOrEqual(2);
    // §9 traveling NPC: its own bot, the travel capability, a continents ring.
    const secretMerchant = loadContentFile(Manifest, join(CONTENT, "manifests/secret_merchant.yaml"));
    expect(secretMerchant.capabilities).toContain("travel");
    expect(secretMerchant.content?.continents).toBe("continents.yaml");
    // §9 player travel: the herald hosts /travel via commands + wayfare.
    const herald = loadContentFile(Manifest, join(CONTENT, "manifests/herald.yaml"));
    expect(herald.capabilities).toEqual(expect.arrayContaining(["commands", "wayfare"]));
    expect(herald.content?.continents).toBe("continents.yaml");
  });

  it("shop, schedule", () => {
    expect(loadContentFile(Shop, join(CONTENT, "shops/aldric.yaml")).items.length).toBeGreaterThan(0);
    expect(loadContentFile(Schedule, join(CONTENT, "schedules/aldric.yaml")).stops.length).toBeGreaterThan(0);
  });

  it("workflows", () => {
    const wander = loadContentFile(Workflow, join(CONTENT, "workflows/merchant_wander.yaml"));
    expect(wander.initial).toBe("at_bazaar");
    expect(wander.singleton).toBe(true); // perpetual loop opts into reboot-dedup
    const build = loadContentFile(Workflow, join(CONTENT, "workflows/player_build.yaml"));
    expect(build.scope).toBe("player");
    expect(build.singleton).toBe(false); // one instance per /build (default)
    // The haggle tree is now a workflow: player-scoped, prompt + guarded options.
    const haggle = loadContentFile(Workflow, join(CONTENT, "workflows/aldric_haggle.yaml"));
    expect(haggle.scope).toBe("player");
    expect(haggle.states.offer!.options.some((o) => o.guard?.expr.includes("gold"))).toBe(true);
    // Sample quest: remembers a choice via set: and gates a later option on context.
    const quest = loadContentFile(Workflow, join(CONTENT, "workflows/merchant_quest.yaml"));
    expect(quest.states.trial!.set).toMatchObject({ path: "event.payload.option" });
    expect(quest.states.verdict!.options.some((o) => o.guard?.expr.includes("context.path"))).toBe(true);
    // Traveling NPC (§9): world-scoped singleton, boot-triggered, arrive/depart loop.
    const secret = loadContentFile(Workflow, join(CONTENT, "workflows/secret_merchant.yaml"));
    expect(secret.scope).toBe("world");
    expect(secret.singleton).toBe(true);
    expect(secret.trigger?.event).toBe("bot.ready");
    expect(Object.keys(secret.states)).toEqual(["arriving", "departing"]);
    // Player travel (§9): player-scoped, travel.requested, remembers the destination.
    const playerTravel = loadContentFile(Workflow, join(CONTENT, "workflows/player_travel.yaml"));
    expect(playerTravel.scope).toBe("player");
    expect(playerTravel.trigger?.event).toBe("travel.requested");
    expect(playerTravel.states.departing!.set).toMatchObject({ destination: "event.payload.continent" });
  });

  it("continents (two dev guilds) and instances", () => {
    const c = loadContentFile(Continents, join(CONTENT, "continents.yaml"));
    expect(Object.keys(c.continents).length).toBe(2);
    expect(loadContentFile(Instances, join(CONTENT, "instances.yaml")).dungeon_pool.length).toBeGreaterThanOrEqual(0);
  });

  it("districts (§2.2): each continent has exactly one bazaar district", () => {
    const d = loadContentFile(Districts, join(CONTENT, "districts.yaml"));
    for (const districts of Object.values(d.districts)) {
      expect(districts.filter((district) => district.holds_bazaar).length).toBe(1);
      expect(districts.length).toBeGreaterThanOrEqual(2);
    }
  });
});
