/**
 * gatekeeper (framework spec §9) — reconciles each player's CONTINENT membership
 * roles: a full **Citizen** role at their home continent, an **Observer** role at
 * every continent they've DISCOVERED, and nothing at undiscovered continents (which
 * world-init keeps invisible). This is what makes §2.3's Undiscovered/Discovered
 * tiers actually bite; "Present" (acting) stays a separate DB-position gate.
 *
 * Discovery is ACCUMULATIVE and never shrinks (§2.2/§2.3), exactly like district
 * `discoveries`: the Observer set = your home's ring-neighbours ∪ everything you've
 * reached (recorded in `continent_discoveries`), minus home. Reconciliation is
 * therefore MONOTONIC — grant the desired roles, never revoke (home migration, the
 * only case needing a downgrade, doesn't exist yet).
 *
 * Runs on the Herald (already in every continent guild with the ring). Three
 * triggers: `guildMemberAdd` (reconcile "at the door" — the onboarding entry point
 * now that the bazaar is role-gated), the `gatekeeper.discover` verb composed into
 * player travel arrival, and a periodic `gatekeeper.sweep` (boot back-grant + drift
 * heal). Role ids come from `continent_roles`, seeded by world-init.
 */
import type { Continents } from "@empire/content-schemas";
import { ensurePlayer, type Sql } from "@empire/db";
import type { Capability, CapabilityContext } from "../capability.js";

interface ContinentRoleRow {
  guild_id: string;
  citizen_role_id: string | null;
  observer_role_id: string | null;
}

/**
 * The continents a player watches as an Observer: their home's ring-neighbours ∪
 * everything they've discovered, minus home itself. Pure — the unit of the
 * accumulative model.
 */
export function observerContinents(continents: Continents, home: string, discovered: Iterable<string>): string[] {
  const set = new Set<string>(continents.continents[home]?.neighbors ?? []);
  for (const guildId of discovered) set.add(guildId);
  set.delete(home);
  return [...set];
}

/** The continents newly discovered by arriving at `continent`: it and its ring-neighbours. */
export function discoveredByArriving(continents: Continents, continent: string): string[] {
  return [continent, ...(continents.continents[continent]?.neighbors ?? [])];
}

export function gatekeeperCapability(continents: Continents): Capability {
  /** Record continents as discovered for a player (accumulative — never removed). */
  async function recordDiscovered(sql: Sql, player: string, guildIds: string[]): Promise<void> {
    for (const guildId of guildIds) {
      await sql`INSERT INTO continent_discoveries (player_id, guild_id) VALUES (${player}, ${guildId}) ON CONFLICT DO NOTHING`;
    }
  }

  /**
   * Reconcile one player's continent roles: grant Citizen at home + Observer at
   * each discovered continent. Grants in guilds the player isn't a member of simply
   * no-op (logged by the gateway) until they join. Monotonic — no revokes.
   */
  async function reconcileOne(ctx: CapabilityContext, player: string): Promise<void> {
    const [p] = await ctx.sql<{ home_guild_id: string }[]>`
      SELECT home_guild_id FROM players WHERE discord_user_id = ${player}
    `;
    if (!p) return; // not a registered player — nothing to reconcile
    const home = p.home_guild_id;

    const discovered = await ctx.sql<{ guild_id: string }[]>`
      SELECT guild_id FROM continent_discoveries WHERE player_id = ${player}
    `;
    const observers = observerContinents(continents, home, discovered.map((d) => d.guild_id));

    const roleRows = await ctx.sql<ContinentRoleRow[]>`SELECT guild_id, citizen_role_id, observer_role_id FROM continent_roles`;
    const roles = new Map(roleRows.map((r) => [r.guild_id, r]));

    const homeRole = roles.get(home)?.citizen_role_id;
    if (homeRole) await ctx.gateway.grantRole(home, player, homeRole);
    for (const guildId of observers) {
      const observerRole = roles.get(guildId)?.observer_role_id;
      if (observerRole) await ctx.gateway.grantRole(guildId, player, observerRole);
    }
    ctx.logger.info({ player, home, observers }, "gatekeeper reconciled continent roles");
  }

  return {
    name: "gatekeeper",
    consumes: [],
    actions: {
      /**
       * Mark the arrived-at continent (and its ring-neighbours) discovered for the
       * acting player, then reconcile. Composed into player_travel `arriving`.
       */
      "gatekeeper.discover": async (args, evt, ctx: CapabilityContext) => {
        const player = evt?.actor?.id;
        if (!player) return;
        const continent = String(args.continent ?? "");
        if (!continent) return;
        await recordDiscovered(ctx.sql, player, discoveredByArriving(continents, continent));
        await reconcileOne(ctx, player);
      },

      /** Reconcile every registered player: boot back-grant + periodic drift heal. */
      "gatekeeper.sweep": async (_args, _evt, ctx: CapabilityContext) => {
        const players = await ctx.sql<{ discord_user_id: string }[]>`SELECT discord_user_id FROM players`;
        for (const p of players) await reconcileOne(ctx, p.discord_user_id);
        ctx.logger.info({ count: players.length }, "gatekeeper sweep complete");
      },
    },

    async init(ctx: CapabilityContext): Promise<void> {
      // The gatekeeper at the door: a player joining their home continent is
      // registered (home = the joined guild if new; existing players keep theirs)
      // and immediately reconciled, so the now-gated bazaar becomes visible at once.
      ctx.gateway.onMemberJoin(async ({ guildId, userId }) => {
        await ensurePlayer(ctx.sql, userId, guildId);
        await reconcileOne(ctx, userId);
      });
    },
  };
}
