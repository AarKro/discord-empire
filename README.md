# Discord Empire

A high-magic medieval empire/idle game that lives entirely inside Discord. Bots
are thin, characterful frontends over a shared backend; the database is the
referee. See [`discord-empire-framework-spec.md`](./discord-empire-framework-spec.md)
(the *what*) and [`discord-empire-tech-spec.md`](./discord-empire-tech-spec.md)
(the *how*).

This repository is **iteration 1**: the framework built against the two
reference bots from the framework spec §10 validation path — **Merchant** and
**Builder** — on two dev continents. The four remaining bots are intentionally
**not** scaffolded yet.

## Agent's-choice decisions (tech spec)

Two items were flagged **agent's choice**; each is decided here with one line of
reasoning, as the tech spec requires:

1. **Runtime → Node LTS (Node 20).** Chosen over Bun because `@discordjs/voice`
   (native Opus/encryption bindings) and Drizzle/`postgres-js` are validated and
   documented against Node LTS first; picking for compatibility over novelty as
   the spec directs.
2. **Content validation → Zod.** Chosen (the recommended option) because it
   validates both YAML content and event payloads at boot/publish and produces
   readable, path-scoped errors (`ContentValidationError`) — see
   `packages/content-schemas`.

Everything else in the stack is fixed by the tech spec (TypeScript strict,
discord.js latest stable, pnpm workspaces with no Turborepo, Postgres, Drizzle +
drizzle-kit with hand-written SQL for the ledger, a custom workflow engine,
pino JSON logging keyed by correlation id, and Postgres LISTEN/NOTIFY as the
event bus).

## Layout

```
packages/
  db/              # Drizzle schema + migrations, ledger + event log, atomic trade helper (FIRST commit)
  content-schemas/ # Zod schemas for manifests/shops/dialogue/workflows + boot validation
  core/            # gateway, event bus, capability registry, ui.kit, persona resolution, capabilities, embedded workflow runtime (§7)
apps/
  bot-merchant/    # reference bot #1 (§10)
  bot-builder/     # reference bot #2 (§10)
  tick-service/    # idle-game heartbeat; zero Discord code
content/           # YAML: manifests, shops, dialogue, schedules, workflows, continents.yaml, instances.yaml
infra/             # docker-compose, Dockerfiles, deploy + backup scripts
.github/workflows/ # CI (lint/typecheck/unit+integration/docker) and manual deploy
```

The four not-yet-built bots (`bot-herald`, `bot-architect`, `bot-tavern`,
`bot-secret-merchant`) and the not-yet-needed capabilities (`presence.watch`,
`market`, `combat`) are deliberately absent until a reference bot needs them.

## Architectural invariants (enforced, do not violate)

- Bots depend on `@empire/core` (+ `@empire/db` types) only; **bots never import
  each other**.
- **Only the `trade` capability writes to the ledger** (`packages/db`'s
  `executeTrade`); workflows reach the economy via the `trade.execute` action,
  dialogue via `trade.request` events consumed by `trade` — which also enforces
  the shop's hidden, reputation-adjusted haggle floor (`effectiveFloor`).
- **Nothing outside `core` touches discord.js directly** — `core/src/gateway.ts`
  is the single import site.
- The ledger is append-only; balances/inventories are derived and reconcilable.
- Events are lossless across restarts: subscribe → replay since last id → drain
  buffer de-duped (see `core/src/bus.ts`).

## Getting started (dev)

Prerequisites: Node 20 LTS, pnpm 9 (`corepack enable`), Docker.

Bot invite permissions (per dev guild): View Channels, Send Messages, Create
Private Threads, Send Messages in Threads, Manage Messages (pin the stall
embed), Manage Threads (archive on dialogue end), Change Nickname, Connect —
plus Manage Channels for the merchant bot so `world:init` can create the
bazaar channels.

Guild IDs live only in `.env` (`GUILD_CONTINENT_ONE/TWO`); content YAML
references them as `${GUILD_CONTINENT_ONE}`-style placeholders that the
content loader expands at boot.

```bash
cp .env.example .env          # fill in bot tokens + dev guild IDs
pnpm install
pnpm start                    # ← the one command; see below
```

**`pnpm start` is the single dev command.** It brings up Postgres, applies any
pending migrations, builds, **seeds the dev world on first run**, then starts all
services in parallel (`.env` loaded, `CONTENT_DIR` → the repo's `content/`). Every
step is conditional, so reruns skip work already done: migrations no-op when none
are pending, `tsc -b` is incremental, and world-init self-skips once the world is
seeded. Ctrl-C stops the services; `pnpm stop` stops Postgres.

Two steps stay explicit — run them when you need them:

```bash
pnpm world:init               # force a re-seed after adding world content (new channels/districts/boards)
pnpm db:generate              # author a migration after editing packages/db/src/schema.ts
```

World bootstrap is idempotent (reruns reuse existing channels and never restock
sold items): it creates a `#bazaar` text channel + `Bazaar` voice channel per
continent guild and seeds the `locations`/`npcs`/inventory rows the render path
reads. It reuses `MERCHANT_TOKEN` (that bot has Manage Channels/Roles).

Quality gates:

```bash
pnpm lint
pnpm typecheck
pnpm test                     # unit tests (integration skipped unless TEST_DATABASE_URL is set)
pnpm test:integration         # DB contract suites against empire_test (never the dev world)
```

The integration suites — the ledger atomic-trade contract (including the
concurrency race: two buyers, one item, exactly one wins, balances reconcile)
and the player starting-grant — TRUNCATE tables between cases, so they run
against a **dedicated `empire_test` database** (created automatically on first
`docker compose up`; see `infra/postgres-init/`). They read `TEST_DATABASE_URL`
and skip when it is unset; they never touch `DATABASE_URL`, so running tests
cannot wipe your dev world.

Players auto-register on their first stall interaction with `STARTING_GOLD`
(default 150) granted through a `starting_grant` ledger row.

Or run a single service (with `.env` exported into your shell first, e.g.
`set -a; . ./.env; set +a`, and `CONTENT_DIR=$PWD/content` for content-reading
services):

```bash
pnpm --filter @empire/bot-merchant build && pnpm --filter @empire/bot-merchant start
```

Or the whole stack containerized: `docker compose -f infra/docker-compose.yml up -d --build`.

## Iteration-1 definition of done (framework spec §10)

- [x] Merchant + Builder scaffolded with **distinct personas per guild** via
      manifest persona resolution (`content/manifests/*.yaml`).
- [x] A **trade race for the last item resolves cleanly** — the atomic contract
      and its concurrency test live in `packages/db`.
- [x] A **new shop/dialogue variant ships via YAML edit only** — content is
      Zod-validated at boot; `content-files.test.ts` guards the shipped files.
- [x] A **bot restart loses zero events** — replay-since-last-processed-id +
      de-dup in the bus (`core/src/bus.ts`).

Discord-touching code (voice, threads, embeds) is validated on the dev servers,
not mocked, per the tech spec.

## Deploy

Manual only: the `Deploy` GitHub Action (`workflow_dispatch`) SSHes to the VPS
and runs `infra/deploy.sh` — `docker compose pull` → forward-only migrations →
`docker compose up -d`. Rollback is a restore from the nightly `pg_dump`
(`infra/backup-cron.sh`).
