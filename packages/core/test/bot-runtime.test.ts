/**
 * Unit tests for manifest-driven capability wiring (§4). buildCapabilities maps a
 * manifest's declared capability names to constructed capabilities, in order,
 * injecting the code-only configs. The full runBot lifecycle (login/subscribe)
 * is a dev-server concern; the wiring is the testable core. These cases use only
 * capabilities that need no content files, so they stay hermetic (no disk/env).
 */
import { describe, it, expect } from "vitest";
import { buildCapabilities } from "../src/bot-runtime.js";
import type { Manifest } from "@empire/content-schemas";

function manifest(caps: string[]): Manifest {
  return { id: "test", token_env: "X", personas: {}, capabilities: caps } as Manifest;
}

describe("buildCapabilities (manifest-driven wiring)", () => {
  it("builds the declared capabilities in manifest order", () => {
    const caps = buildCapabilities(manifest(["trade", "topology", "land", "notify"]), {}, "content");
    expect(caps.map((c) => c.name)).toEqual(["trade", "topology", "land", "notify"]);
  });

  it("injects code-provided configs by capability name", () => {
    const caps = buildCapabilities(
      manifest(["commands", "voicelines", "ambient.chatter"]),
      {
        commands: [{ name: "ping", description: "", route: "" }],
        voicelines: { triggers: {} },
        "ambient.chatter": { reactions: {} },
      },
      "content",
    );
    expect(caps.map((c) => c.name)).toEqual(["commands", "voicelines", "ambient.chatter"]);
  });

  it("throws on an unknown capability name", () => {
    expect(() => buildCapabilities(manifest(["nope"]), {}, "content")).toThrow(/unknown capability "nope"/);
  });

  it("throws when a content-backed capability lacks its content (stall without a shop)", () => {
    expect(() => buildCapabilities(manifest(["stall"]), {}, "content")).toThrow(/content\.shop/);
  });
});
