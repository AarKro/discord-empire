/**
 * Persona resolution (framework spec §4). Every outward-facing action resolves
 * through the persona for the current guild; capabilities never hardcode
 * identity. A bot is one underlying character token with a per-continent face.
 */
import type { Manifest, Persona } from "@empire/content-schemas";

export class PersonaResolver {
  constructor(private readonly manifest: Manifest) {}

  /** Resolve the persona for a guild, or throw — a missing persona is a config bug. */
  resolve(guildId: string): Persona {
    const p = this.manifest.personas[guildId];
    if (!p) {
      throw new Error(
        `No persona for bot "${this.manifest.id}" in guild ${guildId}; add it to the manifest.`,
      );
    }
    return p;
  }

  has(guildId: string): boolean {
    return this.manifest.personas[guildId] !== undefined;
  }

  get guildIds(): string[] {
    return Object.keys(this.manifest.personas);
  }

  /**
   * The event's guild, or this bot's first (home) guild when the event carries
   * none (§4). Centralises the `guildId ?? guildIds[0]!` fallback callers use to
   * pick a guild for an unscoped action.
   */
  homeGuild(guildId?: string | null): string {
    return guildId ?? this.guildIds[0]!;
  }
}
