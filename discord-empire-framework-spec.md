# Discord Empire — Framework & Game Design Brief

A game that lives entirely inside Discord: players build up an economy across multiple servers acting as continents, populated by NPC bots with per-continent personas. This brief defines the world model, the bot framework, and the capabilities needed so that game content can later be authored as modular, low-code workflows. Implementation choices (stack, repo layout, testing, CI/CD) live in the companion `discord-empire-tech-spec.md`.

---

## 1. Vision & principles

A high-magic medieval fantasy idle/empire game in the spirit of Ikariam, played through Discord's native surfaces: channels as places, threads as rooms, embeds and components as UI, the voice sidebar as a living world map.

1. **Bots are frontends, the game lives in the backend.** Every bot is a thin, characterful shell over shared state and a shared event bus. No bot owns game logic.
2. **Capabilities over inheritance.** A bot is assembled from composable capability modules. New bots are configuration, not code.
3. **Content as data.** Dialogue, shops, prices, schedules, and workflows are declarative files (YAML/JSON), hot-reloadable where possible.
4. **Events all the way down.** Everything that happens — a purchase, an NPC arrival, a tick — is an event. Workflows are reactions to events that may emit further events.
5. **The database is the referee.** All economic mutations are atomic, conditional transactions recorded in an append-only ledger. Bots never hold authoritative state.
6. **Seeing is memory, acting is presence.** Visibility is earned once and kept forever; interaction always requires being there.

---

## 2. World model

### 2.1 Continents

Each continent is a Discord server sharing one backend; `guild_id` is simply a location attribute. Continents are arranged in a ring/graph (`neighbors:` per guild in `continents.yaml`).

- **Membership defines continental visibility.** Players are full members of their home continent, auto-invited to neighbor continents with a read-only **Observer role**, and simply not members of anything further away — Discord renders non-neighbor continents invisible by construction.
- **Launch is a three-continent ring.** Everyone starts on Continent One; progression is primarily PvE, with PvP arriving later as opt-in, high-risk/high-reward content.
- Traveling onward is unlocked by a combination of a PvE/quest milestone, a gold travel cost, and a building requirement (e.g. a harbor).
- NPC bots carry a **persona per continent** — different name, avatar, and flavor for the same underlying character/token.

### 2.2 Districts

Within a continent, public life is organized into districts — Discord categories mixing public location channels (bazaar, tavern, landmarks) with players' private land channels. Districts form their own ring for travel purposes.

- **Discovery is accumulative.** Districts start invisible. Entering one for the first time grants its view-role permanently — the map fills in RTS-style and never shrinks. Adjacency governs where you can walk next, not what you remember.
- **Capacity:** Discord allows 500 channels and 50 categories per server, 50 channels per category. With ~5 public location channels per district, each district houses ~20–22 lands, giving roughly 180–200 players per continent — comfortable for a curated community, and later continents add headroom.
- Inactive lands can be pruned to reclaim capacity: state lives fully in the database, channels are deleted and restored identically when the player returns ("back from a long journey").

### 2.3 Presence, travel & interaction tiers

Player position is pure database state (continent + district); Discord only reflects it.

1. **Undiscovered** — channels invisible; the place doesn't exist for you.
2. **Discovered** — you watch the public channels: trades, NPC arrivals, events. Information only.
3. **Present** — you (or, in the future, an agent unit acting for you) are physically there per the database. Only now do stalls, dialogue, market boards, and events respond to you.

Travel is a timed workflow whose duration scales with ring distance, adding roughly **5–20 minutes per hop**. Crucially, travel is a *prefix, not an errand*: a player orders an action from anywhere ("buy at the Bazaar") and the workflow prepends the travel leg, then executes — intent is captured immediately, the body follows. Hard gating means bots verify position before any interaction executes and refuse in-fiction otherwise ("the Bazaar is a 20-minute walk from the Farmlands"). Cross-continent commerce carries additional progression guards (research such as trade routes, a trade-post building, and later an agent on site) — the Observer role alone never suffices.

**Contacts:** two players co-present in a district automatically become contacts (`players.met`). Direct player-to-player trade offers require an existing contact; the global market and auctions remain anonymous. This makes taverns and events genuinely load-bearing meeting places.

### 2.4 Player land

Per continent a player holds one **voice channel** (player-locked; NPCs join it to visibly "visit") and one **text channel**; **buildings are threads** inside the text channel ("🌾 Farm", "⚒️ Forge"), each carrying that building's UI and activity log, with an overview embed pinned in the channel.

- Lands are **private**: permission overwrites for owner + bots only; everything shared happens in public district channels. A player's own land stays visible regardless of where they're standing.
- Land can be held on any continent the player has unlocked.
- Building runs through an Ikariam-style **queue** with timers from the tick service. Building threads are allowed to auto-archive and are un-archived on interaction rather than kept alive artificially.
- NPC visits: a workflow moves an NPC into the land's voice channel → greeting and interaction UI appear in the land text channel, optionally with a voice line into the VC for ambience.

### 2.5 Economy & progression

- **One global currency**, plus continent-local trade goods (items carry an `origin_continent`; the market is global but supply is not — geography creates price differences worth traveling for).
- **Player-to-player trading:** direct offers (contact required), a global market/orderbook, and timed auctions for rares — all settling through the same atomic trade contract as NPC commerce.
- **Idle pacing is hybrid:** fast ticks in the early game, slowing at higher tiers (tick handlers read player tier to scale rates).
- **Research & blueprints:** both an Architect research tree (time + cost) and rare findable blueprints.
- **Per-NPC reputation** affects prices and unlocks dialogue options.
- **Notifications** default to the player's land channel/thread; DMs are an opt-in setting.

### 2.6 Combat & PvE

PvE progression on Continent One layers three things: **quest chains** from NPCs, **world/monster events**, and **economic milestones** — all expressible as workflows with guards, no dedicated quest engine.

Combat itself is **preparation-based**: the player assembles a force and sends it; the fight auto-resolves from stats with **type advantages** providing the strategic layer. No turn-by-turn play — fights can resolve while you're away, and the skill lives in composition.

- **Troops** are generic units with stats, produced by buildings, and dispatchable — they are the game's general-purpose "send someone" mechanic (fights now, trade agents later).
- **The champion** is each player's single hero unit: equips items, has skills that affect battle, the personal stake in any fight.
- Power therefore flows from everything at once: buildings and research (troop quality, unlocks), equipment and blueprints (champion gear), and levels/skills.
- **Solo fights** are 1-v-monster, auto-resolved, delivered as a resolution log in a private thread.
- **Dungeons and raids** are multi-player and *actively played* — and they are **instanced as dedicated Discord servers**. The party's champions are dispatched, members join the instance server, and the run plays out room by room (channels unlocking as encounters clear), with component-based active encounters (timed choices, type-matchup decisions) and combat presentation via embeds/animation frames. Instance servers relax continent rules: party voice will likely be enabled here — fitting, since dungeons are the game's active mode — but always optional; exact rules decided when dungeon presentation is designed.
- **Instance pool:** Discord only lets bots create servers while in fewer than 10 total, so instances come from a **pre-created pool** of dungeon servers the bots administer. A run claims a pool server, rebuilds channels from the dungeon's template, issues single-use invites, and on completion wipes, kicks, and releases it. Pool size caps concurrent runs — scarcity that can be played as fiction ("another party is inside"). Presentation constraint to design around: message edits throttle at ~5/5s per channel and channel renames at 2/10min, so animation means embed image swaps or sequential messages, never renames.
- **Losing costs only the loot chance** (plus the sunk prep). No injuries, no raidable losses in PvE — inviting by design; risk is PvP's job later.

---

## 3. System architecture

```
┌────────────────────────────────────────────────────┐
│                    Discord Guilds                  │
│   (Continent One)  (Continent Two)  (Continent N)  │
└──────▲──────────▲──────────▲──────────▲────────────┘
       │          │          │          │
 ┌─────┴───┐ ┌────┴────┐ ┌───┴─────┐ ┌──┴──────┐
 │Merchant │ │ Builder │ │Architect│ │ Herald  │ ...  ← bot processes
 └─────▲───┘ └────▲────┘ └───▲─────┘ └──▲──────┘        (containers)
       │          │          │          │
┌──────┴──────────┴──────────┴──────────┴───────────┐
│        Event Bus (Postgres LISTEN/NOTIFY)          │
├────────────────────────────────────────────────────┤
│   Workflow Engine   │   Tick Service (idle loop)   │
├────────────────────────────────────────────────────┤
│   Postgres: ledger + event log + state + content   │
└────────────────────────────────────────────────────┘
```

- **Core library** (`@empire/core`): Discord gateway handling, event bus client, DB access layer, capability registry, workflow runtime bindings. Every bot imports this; nothing else touches Discord directly.
- **Bot processes:** one container per Discord application/token, loading a manifest + capabilities and subscribing to relevant events.
- **Event bus:** Postgres LISTEN/NOTIFY behind a `bus.publish()/subscribe()` interface. NOTIFY payloads carry event IDs; consumers read the full row (sidesteps the ~8 KB payload cap). A swap-in path to Redis Streams exists if scale ever demands it.
- **Workflow engine:** executes declarative workflows (Section 7) as its own service; bots are its hands and mouth.
- **Tick service:** the idle-game heartbeat, emitting scheduled events (`tick.minute`, `tick.hour`, `build.completed`, `stock.restocked`, auction closings). Contains zero Discord code.
- **Database:** single Postgres — ledger, event log, derived state, content references, workflow instances.

**Event delivery guarantees:**
- Event log with a monotonic `bigserial` ID; every bot persists its last-processed ID.
- Boot sequence: subscribe first (buffer incoming) → replay since last ID → drain buffer with de-dup by event ID. Restarts are lossless.
- **Transactional emit:** NOTIFY fires inside the same DB transaction as the ledger write — an announced trade is always a committed trade.

---

## 4. Bot anatomy & roster

A bot is fully described by a manifest:

```yaml
id: merchant
token_env: MERCHANT_TOKEN
personas:
  guild_111111: { nickname: "Aldric the Trader", avatar: aldric.png, locale_flavor: highlands }
  guild_222222: { nickname: "Mei Lin", avatar: meilin.png, locale_flavor: harbor }
capabilities:
  - presence.voice
  - stall
  - dialogue.thread
  - trade
  - voicelines
  - ambient.chatter
home:
  guild_111111: { voice_channel: bazaar_vc }
  guild_222222: { voice_channel: harbor_vc }
content:
  shop: shops/aldric.yaml
  dialogue: dialogue/aldric.yaml
  voicelines: audio/aldric/
  schedule: schedules/aldric.yaml
```

**Persona resolution:** every outward-facing action (message, embed, voice line) resolves through the persona for the current guild. Capabilities never hardcode identity.

**Lifecycle:** on boot a bot registers slash commands, applies per-guild nickname/avatar, joins its home voice channel(s) self-muted, announces `bot.ready`, replays missed events, then subscribes to its capability event patterns.

**Launch roster:**

| Bot | Core capabilities | Notes |
|---|---|---|
| Merchant | presence.voice, stall, dialogue.thread, trade, voicelines, ambient.chatter | Reference bot #1 |
| Builder | commands, land, notify, trade, tick integration | Reference bot #2; build queue |
| Herald | ambient.chatter, commands | Announcements, leaderboards on every continent, cross-guild mirroring, Gatekeeper duty |
| Architect | commands, dialogue.thread, trade | Research tree + blueprints |
| Tavern Keeper | presence.voice, dialogue.thread, voicelines, ambient.chatter | Social hub, rumor hook |
| Secret Merchant | presence.voice, stall, dialogue.thread, trade | Own token; rare timed appearances; first candidate for LLM dialogue |

---

## 5. Capability catalog

Each capability is a self-contained module defining the Discord surfaces it uses, events consumed/emitted, and accepted config.

### 5.1 `presence.voice` — NPC location & wandering
NPC-only, player-locked voice channels form the visible world map: players see in the sidebar where characters stand and when they travel. One voice connection per guild — embraced as "one place at a time" per continent. Config includes home channel, wander schedule, and a minimum dwell time so moves stay well under rate limits. A themed transit channel ("⛵ At Sea") can display travel in progress. Emits `npc.arrived`, `npc.departed`, `npc.traveling`.

### 5.2 `presence.watch` — observing activity
Listens to `typingStart` in public location chats (the merchant reacting before you've sent anything) and NPC land-visit events. Player voice tracking is unnecessary — players cannot join voice channels.

### 5.3 `stall` — public shop presence
A pinned embed in the location's text chat: wares, prices, an **Enter the stall** button; refreshed on stock or price changes; opens/closes with the NPC's arrival/departure. Public reactions to sales ("only two left…"). Prices may personalize on entry via reputation.

### 5.4 `dialogue.thread` — private conversations
Opens a private thread (player + bot) and runs a dialogue tree from content files; archives on completion or timeout. Trees are data: nodes with bot text, player options (buttons/selects/modal inputs), guards (reputation, gold, flags, position), and emitted events — the same node format as workflows, so haggling logic (offers/counteroffers against a hidden floor) is authorable without code. A `generated` node type is reserved for future LLM-worded dialogue: the model would supply wording only; prices and outcomes always come from node data and the trade capability.

### 5.5 `trade` — economic actions
The only capability allowed to write to the ledger. Executes atomic, conditional transactions (Section 8) for NPC commerce and settles all player-to-player flows. Offers are **quotes with expiry** (default 5 minutes), never reservations; confirmation re-validates everything atomically and failures return in-fiction reasons ("sorry, just sold out!").

### 5.6 `ui.kit` — interaction primitives (shared toolbox)
Wrappers for ephemeral responses, button rows, select menus, modals, paginated embeds, confirmation dialogs, and rendered-image embeds. All capabilities build UI through this kit for consistency and a single adoption point for Components V2.

### 5.7 `voicelines` — prerecorded audio
Plays cached Opus files in the bot's current voice channel on event triggers (`npc.arrived`, `stall.entered`, `trade.completed`), with cooldowns and per-persona line sets. Nearly free to run; the trigger mapping is content, not code.

### 5.8 `ambient.chatter` — liveliness
Scheduled and randomized flavor posts in location chats, plus reactions to world events ("a caravan from Continent Two just docked!"). Throttled; pure flavor.

### 5.9 `notify` — receipts & pings
Posts to the player's land channel/thread by default; DMs opt-in via `/settings notifications`. Fallback chain: preferred target → land thread → skip with log.

### 5.10 `commands` — slash command surface
Declarative command definitions routed to workflows/capabilities, with autocomplete backed by game data (item names, blueprints, destinations).

### 5.11 `market` — player-to-player economy
Three flows, all settling through `trade`'s atomic contract:
- **Direct offers** — requires an existing contact; recipient confirms via UI; quote-style expiry.
- **Global market/orderbook** — buy/sell orders on goods, matched at placement, browsable via ephemeral UI; global across continents (local goods + travel create geography, not artificial market splits).
- **Auctions** — timed listings for rares; tick service closes them; bids escrowed in the ledger.

### 5.12 `land` — player holdings
Implements the land model of Section 2.4: channel provisioning under district categories, private permissions, building threads, the build-queue UI, pruning/restore, and the NPC-visit interaction surface.

### 5.13 `combat` — encounters & dispatch
Implements Section 2.6: force assembly UI (troops + champion loadout), the resolution engine (stats + type matchups, seeded & logged for auditability), encounter workflows for solo fights (resolution-log threads) and dungeons/raids (party assembly via contacts/co-presence, instance-server lifecycle: claim from pool → build from template → invite → run → wipe & release), loot rolls settling through `trade`, and the underlying **dispatch** primitive — a unit with position, travel timer, and a mission — shared with future trade agents.

### 5.14 `topology` — position, travel & discovery
Implements Section 2.3: the travel workflow (`travel.started` → distance-scaled timer → `travel.arrived`), including travel-as-prefix (queued actions carry their travel leg), `district.discovered` on first arrival with permanent view-role grant and Herald flavor, `players.met` on co-presence, the `requires_presence` check every interactive capability calls, and cross-continent progression guards. Arrival narrations in the player's land channel make channels appearing feel intentional rather than glitchy.

---

## 6. Event model

A single envelope for everything on the bus:

```json
{
  "id": "evt_01J...",
  "type": "trade.completed",
  "ts": "2026-07-18T14:03:00Z",
  "guild_id": "111111",
  "actor": { "kind": "player", "id": "discord_user_id" },
  "subject": { "kind": "npc", "id": "merchant" },
  "payload": { "item": "blueprint_arcane_forge", "qty": 1, "price": 120 },
  "correlation_id": "wf_8f2..."
}
```

- **Namespaced types:** `player.*`, `npc.*`, `stall.*`, `dialogue.*`, `trade.*`, `market.*`, `auction.*`, `build.*`, `research.*`, `combat.*`, `dungeon.*`, `travel.*`, `district.*`, `players.*`, `tick.*`, `world.*`.
- **Correlation IDs** tie chains together (stall click → dialogue → offer → trade share one) — essential for debugging emergent behavior.
- Events are persisted to the event log — the replay source, the debugging tool, and analytics in one.

---

## 7. Workflow engine (the low-code layer)

Workflows are declarative state machines: **trigger → states → actions → emitted events**.

```yaml
id: secret_merchant_appearance
trigger: { event: tick.hour, filter: { random_chance: 0.15 } }
context: { npc: secret_merchant }
states:
  appear:
    actions:
      - npc.move_to: { channel: hidden_grove_vc }
      - stall.open: { shop: shops/secret_rotating.yaml }
      - emit: { type: world.rumor, payload: { hint: "hooded figure" } }
    on:
      timer(90m): vanish
  vanish:
    actions:
      - stall.close
      - npc.move_to: { channel: nowhere_vc }
    final: true
```

- **Triggers:** any event type with payload filters (including random chance), manual start via slash command, or cron-like schedules via the tick service.
- **States** carry entry **actions**, event-keyed **transitions** with filters, **timers** (`after: 10m → state`), and **guards** on game state (`player.gold >= 50`, `player.reputation.merchant >= 3`, `player.position == location.district`, `player.research.trade_routes`).
- **Actions** are the verbs capabilities export; the action registry is discoverable — the foundation for a future visual workflow editor.
- **Instances** are persisted and scoped `per: player` (quests, build queues), `per: npc` (schedules), or `per: world` (global events); they survive restarts.
- **Concurrency rule:** workflows never mutate the economy directly — they call `trade.execute`, and races resolve at the ledger.
- **Failure handling:** per-action `on_error: state | retry(n) | abort`; aborts emit `workflow.failed`.

Dialogue trees share this node/transition format with UI actions — one authoring mental model for haggling, quests, wander schedules, and continent-unlock chains alike.

---

## 8. Data layer

- **Ledger (append-only):** every economic change is a transaction row (actor, counterparty, currency delta, item deltas, cause event ID). Balances and inventories are derived state. Covers NPC trades, P2P trades, market fills, auction escrow/settlement, build and research costs. Enables audit, revert, and "where did this gold come from" forever.
- **Atomicity contract:** one DB transaction with conditional updates (`WHERE stock >= qty`, `WHERE balance >= price`); any failing condition rolls back everything and emits `trade.failed(reason)`. No locking of NPCs or players — two players racing for the last item both haggle freely; the ledger decides.
- **Game state:** players (position, tier, notification prefs), NPCs, locations (guild + channel mapping, `requires_presence`), districts (ring edges, discovery grants), land plots and build queues, research progress, blueprints, per-NPC reputation, contacts, flags, offers/orders/auctions with expiry, workflow instances, per-bot last-processed event ID.
- **Content:** shops, dialogue, schedules, research tree, and voice-line manifests as versioned files in the repo, validated at boot — fast iteration, code review for game content.

---

## 9. Orchestration & operations

- **Deployment:** Docker Compose on a single small VPS (Hetzner-class). Services: six bot containers, workflow engine, tick service, Postgres. Bots are stateless — kill or restart any time.
- **Config:** manifests and content as mounted volumes; tokens via env; `continents.yaml` mapping guild IDs → continent metadata (name, neighbors, progression order, resource bias, locale flavor); `instances.yaml` listing the dungeon-pool guild IDs.
- **Boot registration:** commands, personas, and home positions applied idempotently per guild.
- **Rate-limit hygiene:** the core library centralizes Discord calls per bot with queueing; capabilities declare cost hints (channel moves, role changes) so the framework can throttle bursts (e.g. an event pulling thirty players' role grants at once).
- **Gatekeeper duty** (Herald or a standalone loop): reconciles for every player their continent memberships (full role at home, Observer at neighbors, absent elsewhere) and accumulated district view-roles, on `travel.arrived`, home migration, and a periodic sweep. Also manages the **dungeon instance pool**: claim/release state, template rebuilds, single-use invites, and post-run cleanup.
- **Observability:** structured logs keyed by correlation ID; the event log is the primary debugging tool; a hidden Ops bot with `/admin events`, `/admin workflow inspect`, `/admin ledger revert`.
- **Cross-guild actions:** Herald mirrors `world.*` events (announcements, leaderboards, auction results) to every continent.

---

## 10. Validation path

The framework is built against two reference bots, in order — nothing enters core until one of them needs it:

**Merchant** — stands in the Bazaar with a stall embed; Enter-the-stall button → private thread → scripted haggle with hidden, reputation-adjusted floor → atomic purchase → receipt to the land channel; wander workflow between two locations; typing reaction in stall chat.

**Builder** — `/build` with blueprint autocomplete → cost and position guards → ledger deduction → per-player queue instance with tier-scaled timer; tick fires completion → building thread updated → notification per player preference.

**Definition of done:** both bots run on two guilds simultaneously with distinct personas; a trade race for the last item resolves cleanly; a new shop or dialogue variant ships by editing YAML only; a bot restart mid-day loses zero events.

---

## 11. Roadmap (beyond iteration 1)

- Trade agents & caravans — reuse of the combat dispatch primitive with standing orders ("buy X below Y"); the intended remote-interaction mechanism
- PvP/raiding — opt-in, high-risk/high-reward, on later continents
- LLM-worded dialogue via the reserved `generated` node type (Secret Merchant first)
- Generated land-map images (schema is real from day one; render starts as embed text)
- Alliances (roles + shared channels)
- Visual workflow editor on top of the action registry
- Dungeon presentation design (encounter animations, party voice rules inside instances)
- Audio beyond prerecorded lines
