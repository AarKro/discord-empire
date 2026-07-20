/**
 * Unit tests for the slash-command surface (§5.10). Discord/Postgres are faked
 * (invariant: we never mock discord.js clients — the Discord-touching code is
 * validated on dev servers). We test the plain-data core: command routing
 * publishes the right bus event, a result event with a matching correlationId
 * resolves the held reply, autocomplete resolver shape, direct-answer resolve,
 * and the pure CommandDef→Discord-API JSON mapping.
 */
import { describe, it, expect, vi } from "vitest";
import { commandsCapability, type CommandDef } from "../src/capabilities/commands.js";
import { toApplicationCommandJson } from "../src/gateway.js";
import type { BusEvent } from "../src/bus.js";
import type { CapabilityContext } from "../src/capability.js";
import type { CommandInteraction, AutocompleteInteraction } from "../src/gateway.js";

interface FakeGateway {
  commandHandlers: ((i: CommandInteraction) => Promise<void> | void)[];
  autocompleteHandlers: ((i: AutocompleteInteraction) => Promise<{ name: string; value: string }[]>)[];
  registered: { guildId: string; defs: unknown[] }[];
}

interface FakeCtx {
  ctx: CapabilityContext;
  published: { type: string; correlationId?: string; payload?: Record<string, unknown>; subject?: { id: string } }[];
  gateway: FakeGateway;
}

function makeCtx(sqlRows: (q: string) => unknown[] = () => []): FakeCtx {
  const published: FakeCtx["published"] = [];
  const gateway: FakeGateway = { commandHandlers: [], autocompleteHandlers: [], registered: [] };
  const sql = (strings: TemplateStringsArray): Promise<unknown[]> =>
    Promise.resolve(sqlRows(strings.join("?")));
  const log = { info: () => {}, warn: () => {}, error: () => {}, child: () => log };
  const ctx = {
    bot: "builder",
    sql: sql as unknown as CapabilityContext["sql"],
    bus: {
      publish: async (input: FakeCtx["published"][number]) => {
        published.push(input);
        return input as never;
      },
    } as unknown as CapabilityContext["bus"],
    gateway: {
      onCommand: (h: FakeGateway["commandHandlers"][number]) => gateway.commandHandlers.push(h),
      onAutocomplete: (h: FakeGateway["autocompleteHandlers"][number]) => gateway.autocompleteHandlers.push(h),
      registerApplicationCommands: async (guildId: string, defs: unknown[]) => {
        gateway.registered.push({ guildId, defs });
      },
    } as unknown as CapabilityContext["gateway"],
    personas: { guildIds: ["g1", "g2"] } as unknown as CapabilityContext["personas"],
    logger: log as unknown as CapabilityContext["logger"],
    config: {},
  } as CapabilityContext;
  return { ctx, published, gateway };
}

function fakeInteraction(over: Partial<CommandInteraction> & { commandName: string }): {
  interaction: CommandInteraction;
  replies: string[];
} {
  const replies: string[] = [];
  const interaction: CommandInteraction = {
    commandName: over.commandName,
    options: over.options ?? {},
    userId: over.userId ?? "u1",
    guildId: over.guildId ?? "g1",
    channelId: over.channelId ?? "c1",
    reply: async (content: string) => {
      replies.push(content);
    },
  };
  return { interaction, replies };
}

const buildDef: CommandDef = {
  name: "build",
  description: "Queue a building",
  route: "build.requested",
  options: [{ name: "blueprint", description: "What to build", autocomplete: true, required: true }],
  autocomplete: async (_ctx, typed) =>
    [
      { name: "Wheat Farm (50g)", value: "farm" },
      { name: "Blacksmith Forge (100g)", value: "forge" },
    ].filter((c) => c.value.includes(typed)),
};

const balanceDef: CommandDef = {
  name: "balance",
  description: "How much coin you carry",
  route: "",
  resolve: async () => "You carry **42 gold**.",
};

describe("commands: registration (§9)", () => {
  it("registers every persona guild's command set on init", async () => {
    const f = makeCtx();
    const cap = commandsCapability([buildDef, balanceDef]);
    await cap.init!(f.ctx);
    expect(f.gateway.registered.map((r) => r.guildId)).toEqual(["g1", "g2"]);
    expect((f.gateway.registered[0]!.defs as { name: string }[]).map((d) => d.name)).toEqual([
      "build",
      "balance",
    ]);
  });
});

describe("commands: round-trip routing (§5.10)", () => {
  it("publishes the route event with a correlationId, player actor, and options payload", async () => {
    const f = makeCtx();
    const cap = commandsCapability([buildDef]);
    await cap.init!(f.ctx);
    const { interaction } = fakeInteraction({ commandName: "build", options: { blueprint: "farm" } });
    await f.gateway.commandHandlers[0]!(interaction);

    const routed = f.published.find((e) => e.type === "build.requested");
    expect(routed).toBeDefined();
    expect(routed!.correlationId).toMatch(/^cmd_/);
    expect(routed!.payload).toEqual({ blueprint: "farm" });
    expect(routed!.subject?.id).toBe("builder");
  });

  it("resolves the held ephemeral reply when a result event with the same correlationId arrives", async () => {
    const f = makeCtx();
    const cap = commandsCapability([buildDef]);
    await cap.init!(f.ctx);
    const { interaction, replies } = fakeInteraction({ commandName: "build", options: { blueprint: "farm" } });
    await f.gateway.commandHandlers[0]!(interaction);
    const corr = f.published.find((e) => e.type === "build.requested")!.correlationId!;

    // A build.queued result addressed to this bot with the matching corr id.
    cap.handle!(
      {
        type: "build.queued",
        subject: { kind: "npc", id: "builder" },
        correlationId: corr,
        payload: { message: "Foundation laid: Wheat Farm, ready in ~5m." },
        actor: { kind: "player", id: "u1" },
        dbId: "1",
        eventId: "e1",
        ts: "",
        guildId: "g1",
      } as BusEvent,
      f.ctx,
    );
    // settle() calls reply asynchronously; flush microtasks.
    await Promise.resolve();
    expect(replies).toEqual(["Foundation laid: Wheat Farm, ready in ~5m."]);
  });

  it("ignores result events whose correlationId is not held (broadcast bus)", async () => {
    const f = makeCtx();
    const cap = commandsCapability([buildDef]);
    await cap.init!(f.ctx);
    const { interaction, replies } = fakeInteraction({ commandName: "build", options: { blueprint: "farm" } });
    await f.gateway.commandHandlers[0]!(interaction);
    cap.handle!(
      {
        type: "build.queued",
        subject: { kind: "npc", id: "builder" },
        correlationId: "cmd_other",
        payload: { message: "not mine" },
        actor: null,
        dbId: "1",
        eventId: "e1",
        ts: "",
        guildId: "g1",
      } as BusEvent,
      f.ctx,
    );
    await Promise.resolve();
    expect(replies).toEqual([]);
  });

  it("times out to an in-fiction fallback when no result arrives", async () => {
    vi.useFakeTimers();
    try {
      const f = makeCtx();
      const cap = commandsCapability([buildDef]);
      await cap.init!(f.ctx);
      const { interaction, replies } = fakeInteraction({ commandName: "build", options: { blueprint: "farm" } });
      await f.gateway.commandHandlers[0]!(interaction);
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      expect(replies[0]).toContain("scratches his head");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("commands: direct-answer resolve (§5.10)", () => {
  it("answers /balance immediately without a bus round-trip", async () => {
    const f = makeCtx();
    const cap = commandsCapability([balanceDef]);
    await cap.init!(f.ctx);
    const { interaction, replies } = fakeInteraction({ commandName: "balance" });
    await f.gateway.commandHandlers[0]!(interaction);
    expect(replies).toEqual(["You carry **42 gold**."]);
    expect(f.published).toEqual([]);
  });

  it("ignores commands it does not own (shared gateway)", async () => {
    const f = makeCtx();
    const cap = commandsCapability([balanceDef]);
    await cap.init!(f.ctx);
    const { interaction, replies } = fakeInteraction({ commandName: "someone-elses" });
    await f.gateway.commandHandlers[0]!(interaction);
    expect(replies).toEqual([]);
    expect(f.published).toEqual([]);
  });
});

describe("commands: autocomplete resolver (§5.10)", () => {
  it("routes autocomplete to the owning CommandDef and returns {name,value}[]", async () => {
    const f = makeCtx();
    const cap = commandsCapability([buildDef]);
    await cap.init!(f.ctx);
    const choices = await f.gateway.autocompleteHandlers[0]!({
      commandName: "build",
      focusedOption: "blueprint",
      value: "for",
      userId: "u1",
      guildId: "g1",
    });
    expect(choices).toEqual([{ name: "Blacksmith Forge (100g)", value: "forge" }]);
  });

  it("returns no choices for a command without an autocomplete resolver", async () => {
    const f = makeCtx();
    const cap = commandsCapability([balanceDef]);
    await cap.init!(f.ctx);
    const choices = await f.gateway.autocompleteHandlers[0]!({
      commandName: "balance",
      focusedOption: "x",
      value: "",
      userId: "u1",
      guildId: "g1",
    });
    expect(choices).toEqual([]);
  });
});

describe("toApplicationCommandJson (CommandDef → Discord API JSON)", () => {
  it("maps names/descriptions and coerces every option to a required-aware STRING", () => {
    const json = toApplicationCommandJson([
      { name: "build", description: "Queue a building", options: [{ name: "blueprint", description: "What", autocomplete: true, required: true }] },
      { name: "balance", description: "Coin" },
    ]);
    expect(json).toEqual([
      {
        name: "build",
        description: "Queue a building",
        type: 1,
        options: [{ type: 3, name: "blueprint", description: "What", required: true, autocomplete: true }],
      },
      { name: "balance", description: "Coin", type: 1, options: [] },
    ]);
  });
});
