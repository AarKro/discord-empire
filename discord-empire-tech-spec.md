# Discord Empire — Technical Spec

Companion to `discord-empire-framework-spec.md` (the design brief: *what* to build). This file fixes the *how*. Where a choice is marked **agent's choice**, the implementing agent decides and documents the pick in the repo README; everything else is settled.

## Stack

| Concern | Decision |
|---|---|
| Language | TypeScript (strict mode) |
| Discord library | discord.js (latest stable) |
| Runtime | **Agent's choice** — Node LTS or Bun; pick for compatibility with discord.js voice + Drizzle, not novelty |
| Package layout | Single repo, **pnpm workspaces** (no Turborepo — build graph is trivial) |
| Database | PostgreSQL (single instance) |
| DB access | **Drizzle ORM** + drizzle-kit for migrations; hand-written SQL permitted (and expected) for the ledger's conditional atomic updates |
| Event bus | Postgres LISTEN/NOTIFY behind `bus.publish()/subscribe()` (see brief §3 for delivery guarantees) |
| Workflow engine | **Custom** — it is the product's core; do not build on XState or similar |
| Content validation | **Agent's choice** (Zod recommended) — but whatever is chosen must validate all YAML content and event payloads at boot/publish with readable errors |
| Logging | Structured JSON to stdout, keyed by correlation ID (pino or equivalent) |

## Repository layout

```
packages/
  core/            # gateway handling, bus, capability registry, ui.kit, persona resolution
  db/              # drizzle schema, migrations, ledger transaction helpers
  content-schemas/ # validation schemas for manifests, shops, dialogue, workflows
apps/
  bot-merchant/  bot-builder/  bot-herald/
  bot-architect/ bot-tavern/   bot-secret-merchant/
  workflow-engine/
  tick-service/
content/           # YAML: manifests, shops, dialogue, schedules, workflows, continents.yaml, instances.yaml
infra/             # docker-compose.yml, Dockerfiles, deploy scripts
```

Rules the layout enforces (agent must preserve them):
- Bots depend on `core` (+ `db` types) only; bots never import each other.
- Only the `trade` capability in `core` writes to the ledger.
- Nothing outside `core` touches discord.js directly.

## Testing

- **Unit tests** (vitest) on core logic: workflow engine transitions/guards/timers, dialogue tree resolution, bus replay/de-dup, content validation.
- **One integration suite** (the only one): the ledger's atomic trade contract against a real Postgres (Docker locally, service container in CI). Must include the concurrency case: two buyers race for the last item — exactly one succeeds, ledger balances reconcile.
- No Discord API mocking; Discord-touching code is validated on the dev servers.

## Environments

- **Dev:** a set of private Discord test servers (2 continents + 1 dungeon-pool server minimum) with separate bot applications/tokens; config via `.env` (gitignored, `.env.example` committed).
- **Prod:** single VPS (Hetzner-class), Docker Compose; separate bot applications from dev.
- Secrets: `.env` on the VPS, GitHub Actions secrets for deploy; never in the repo.

## CI/CD (GitHub Actions)

- **On PR/push:** lint, typecheck, unit tests, ledger integration test (Postgres service container), Docker builds.
- **Deploy:** `workflow_dispatch` (manual trigger) only → SSH to VPS → `docker compose pull && docker compose up -d` → run pending drizzle migrations before starting app containers.
- Migrations are forward-only in prod; rollback = restore from the nightly `pg_dump` (a cron on the VPS).

## Guidance for the implementing agent

1. Read the design brief fully before scaffolding; its §10 validation path (Merchant + Builder on two dev guilds) is the milestone — do not scaffold all six bots first.
2. First commit: `packages/db` — ledger, event log, and the trade transaction helper with its integration test.
3. When the brief and convenience conflict (e.g. "just this once a bot writes the DB directly"), the brief wins.
4. Document every **agent's choice** made, with one sentence of reasoning, in the root README.
