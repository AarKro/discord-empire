/**
 * Boot-time content validation, proven against the REAL YAML shipped in
 * content/ (framework spec §8 "validated at boot"). Guards the §10 DoD line
 * "a new shop or dialogue variant ships by editing YAML only" — a malformed
 * edit fails here (and at boot) rather than at runtime.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
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
  Riddles,
} from "../src/index.js";

const CONTENT = join(dirname(fileURLToPath(import.meta.url)), "../../../content");

// The shipped YAML references dev guild IDs via ${VAR} substitution; supply
// stand-ins so the files validate without a real .env (as they do at boot).
process.env.GUILD_CONTINENT_ONE ??= "guild_111111";
process.env.GUILD_CONTINENT_TWO ??= "guild_222222";
process.env.GUILD_CONTINENT_THREE ??= "guild_333333";

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
    // §9/§2.3 player travel: the herald hosts /travel + /move via commands +
    // wayfare (continents) + topology (districts).
    const herald = loadContentFile(Manifest, join(CONTENT, "manifests/herald.yaml"));
    expect(herald.capabilities).toEqual(expect.arrayContaining(["commands", "wayfare", "topology"]));
    expect(herald.content?.continents).toBe("continents.yaml");
    // §5.11 player market: the exchange bot hosts /trade, /stall via commands + market.
    const exchange = loadContentFile(Manifest, join(CONTENT, "manifests/exchange.yaml"));
    expect(exchange.capabilities).toEqual(expect.arrayContaining(["commands", "market"]));
    // §4/§5 research: the architect bot hosts /research + /techtree via commands + research.
    const architect = loadContentFile(Manifest, join(CONTENT, "manifests/architect.yaml"));
    expect(architect.capabilities).toEqual(expect.arrayContaining(["commands", "research"]));
    // §9 ops bot: the hidden admin surface — commands only, its own token, no home.
    const ops = loadContentFile(Manifest, join(CONTENT, "manifests/ops.yaml"));
    expect(ops.capabilities).toEqual(["commands"]);
    expect(ops.token_env).toBe("OPS_TOKEN");
    expect(ops.home).toBeUndefined();
  });

  it("shop, schedule", () => {
    expect(loadContentFile(Shop, join(CONTENT, "shops/aldric.yaml")).items.length).toBeGreaterThan(0);
    expect(loadContentFile(Schedule, join(CONTENT, "schedules/aldric.yaml")).stops.length).toBeGreaterThan(0);
  });

  it("the riddle workflow wires modal options to the states that capture them", () => {
    const wf = loadContentFile(Workflow, join(CONTENT, "workflows/secret_merchant_riddle.yaml"));
    expect(wf.scope).toBe("player");

    // The initial state must carry a prompt: the first render has to be a
    // dialogue.opened so the render capability opens the private thread. Without
    // it every later prompt is a dialogue.node into a thread that doesn't exist.
    expect(wf.states[wf.initial]?.prompt).toBeTruthy();

    // Every modal option needs an `input` spec, and must land on a state whose
    // `set:` actually captures event.payload.input — otherwise the player types
    // into the void.
    const modalOptions = Object.values(wf.states).flatMap((s) => s.options.filter((o) => o.kind === "modal"));
    expect(modalOptions.length).toBeGreaterThan(0);
    for (const option of modalOptions) {
      expect(option.input, `option "${option.id}" is kind: modal but has no input spec`).toBeTruthy();
      const target = wf.states[option.goto ?? ""];
      expect(target, `option "${option.id}" has no goto target`).toBeTruthy();
      expect(
        Object.values(target!.set),
        `option "${option.id}" goes to a state that never reads event.payload.input`,
      ).toContain("event.payload.input");
    }

    // Every `goto`/`on:`/timer target must exist, or the session dead-ends.
    const targets = Object.values(wf.states).flatMap((s) => [
      ...Object.values(s.on),
      ...s.options.map((o) => o.goto).filter((g): g is string => Boolean(g)),
      ...(s.timer ? [s.timer.goto] : []),
    ]);
    for (const target of targets) expect(Object.keys(wf.states)).toContain(target);
  });

  it("riddles — each carries exactly the three hints the question budget spends", () => {
    const book = loadContentFile(Riddles, join(CONTENT, "riddles.yaml"));
    expect(book.riddles.length).toBeGreaterThan(0);
    for (const riddle of book.riddles) {
      expect(riddle.hints).toHaveLength(3);
      expect(riddle.answers.length).toBeGreaterThan(0);
    }
    // Ids are the player-flag key (`riddle_<id>`), so a duplicate would make one
    // riddle unwinnable the moment the other was solved.
    const ids = book.riddles.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
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
    // Player district walk (§2.3): player-scoped, district.move.requested.
    const playerMove = loadContentFile(Workflow, join(CONTENT, "workflows/player_move.yaml"));
    expect(playerMove.scope).toBe("player");
    expect(playerMove.trigger?.event).toBe("district.move.requested");
    expect(playerMove.states.departing!.set).toMatchObject({ district: "event.payload.district" });
  });

  it("continents (§2.1 three-continent ring) and instances", () => {
    const c = loadContentFile(Continents, join(CONTENT, "continents.yaml"));
    const guilds = Object.keys(c.continents);
    expect(guilds.length).toBe(3);
    // A true ring: every continent neighbours both others, every neighbour is a
    // continent that exists, and nobody names themselves. A dangling neighbour
    // id is invisible to the schema but breaks /travel and the Observer grants.
    for (const [guildId, meta] of Object.entries(c.continents)) {
      expect(meta.neighbors).not.toContain(guildId);
      expect([...meta.neighbors].sort()).toEqual(guilds.filter((g) => g !== guildId).sort());
    }
    // Distinct orders — startContinent() picks the minimum, so a tie is ambiguous.
    const orders = Object.values(c.continents).map((meta) => meta.order);
    expect(new Set(orders).size).toBe(orders.length);
    expect(loadContentFile(Instances, join(CONTENT, "instances.yaml")).dungeon_pool.length).toBeGreaterThanOrEqual(0);
  });

  it("every bot wears a persona on every continent", () => {
    const guilds = Object.keys(loadContentFile(Continents, join(CONTENT, "continents.yaml")).continents);
    for (const file of readdirSync(join(CONTENT, "manifests"))) {
      const m = loadContentFile(Manifest, join(CONTENT, "manifests", file));
      // A bot with no persona for a guild throws at boot the moment it acts
      // there (PersonaResolver.resolve), so adding a continent means touching
      // every manifest — this is what catches the one you forgot.
      expect(Object.keys(m.personas).sort(), `${file} personas`).toEqual([...guilds].sort());
    }
  });

  it("districts (§2.2): each continent has exactly one bazaar district", () => {
    const d = loadContentFile(Districts, join(CONTENT, "districts.yaml"));
    const guilds = Object.keys(loadContentFile(Continents, join(CONTENT, "continents.yaml")).continents);
    expect(Object.keys(d.districts).sort()).toEqual([...guilds].sort());
    for (const districts of Object.values(d.districts)) {
      expect(districts.filter((district) => district.holds_bazaar).length).toBe(1);
      expect(districts.length).toBeGreaterThanOrEqual(2);
      // Neighbours must name siblings on the same continent.
      const ids = new Set(districts.map((district) => district.id));
      for (const district of districts) {
        for (const neighbor of district.neighbors ?? []) expect(ids).toContain(neighbor);
      }
    }
  });
});
