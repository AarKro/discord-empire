import { describe, it, expect } from "vitest";
import { substituteEnv } from "../src/index.js";

describe("substituteEnv", () => {
  it("expands ${VAR} placeholders from the provided env", () => {
    const out = substituteEnv(
      `personas:\n  "\${GUILD_A}": { nickname: Aldric }\n  "\${GUILD_B}": { nickname: Mei }\n`,
      "manifest.yaml",
      { GUILD_A: "111", GUILD_B: "222" },
    );
    expect(out).toContain(`"111":`);
    expect(out).toContain(`"222":`);
    expect(out).not.toContain("${");
  });

  it("names every missing variable and the source file", () => {
    expect(() => substituteEnv("a: ${MISSING_ONE}\nb: ${MISSING_TWO}\n", "continents.yaml", {}))
      .toThrowError(/continents\.yaml.*MISSING_ONE, MISSING_TWO/s);
  });

  it("treats an empty value as missing (unset .env lines)", () => {
    expect(() => substituteEnv("a: ${EMPTY_VAR}", "x.yaml", { EMPTY_VAR: "" })).toThrowError(
      /EMPTY_VAR/,
    );
  });

  it("leaves text without placeholders untouched", () => {
    const raw = "id: merchant\nprice: 5\n";
    expect(substituteEnv(raw, "x.yaml", {})).toBe(raw);
  });
});
