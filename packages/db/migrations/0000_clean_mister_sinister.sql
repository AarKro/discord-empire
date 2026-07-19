CREATE TABLE IF NOT EXISTS "balances" (
	"owner_kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"currency" text DEFAULT 'gold' NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "balances_owner_kind_owner_id_currency_pk" PRIMARY KEY("owner_kind","owner_id","currency")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "blueprints" (
	"owner_id" text NOT NULL,
	"blueprint_id" text NOT NULL,
	"source" text DEFAULT 'research' NOT NULL,
	CONSTRAINT "blueprints_owner_id_blueprint_id_pk" PRIMARY KEY("owner_id","blueprint_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "build_queue" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"plot_id" text NOT NULL,
	"blueprint_id" text NOT NULL,
	"thread_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"completes_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bus_cursors" (
	"consumer" text PRIMARY KEY NOT NULL,
	"last_processed_id" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contacts" (
	"player_a" text NOT NULL,
	"player_b" text NOT NULL,
	"met_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_player_a_player_b_pk" PRIMARY KEY("player_a","player_b")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "discoveries" (
	"player_id" text NOT NULL,
	"district_id" text NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discoveries_player_id_district_id_pk" PRIMARY KEY("player_id","district_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "districts" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"name" text NOT NULL,
	"category_id" text,
	"view_role_id" text,
	"neighbors" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"guild_id" text,
	"actor_kind" text,
	"actor_id" text,
	"subject_kind" text,
	"subject_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"correlation_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inventories" (
	"owner_kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"item_id" text NOT NULL,
	"qty" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "inventories_owner_kind_owner_id_item_id_pk" PRIMARY KEY("owner_kind","owner_id","item_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "land_plots" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"district_id" text,
	"voice_channel_id" text,
	"text_channel_id" text,
	"pruned" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"counterparty_kind" text NOT NULL,
	"counterparty_id" text NOT NULL,
	"currency" text DEFAULT 'gold' NOT NULL,
	"currency_delta" bigint NOT NULL,
	"item_deltas" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"cause_event_id" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locations" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text,
	"district_id" text,
	"kind" text NOT NULL,
	"requires_presence" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "npcs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'merchant' NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "offers" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"maker_kind" text NOT NULL,
	"maker_id" text NOT NULL,
	"item_id" text NOT NULL,
	"qty" integer NOT NULL,
	"price" bigint NOT NULL,
	"side" text DEFAULT 'sell' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "players" (
	"discord_user_id" text PRIMARY KEY NOT NULL,
	"home_guild_id" text NOT NULL,
	"position_guild_id" text,
	"position_district_id" text,
	"tier" integer DEFAULT 1 NOT NULL,
	"notification_prefs" jsonb DEFAULT '{"target":"land","dm":false}'::jsonb NOT NULL,
	"flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reputation" (
	"player_id" text NOT NULL,
	"npc_id" text NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "reputation_player_id_npc_id_pk" PRIMARY KEY("player_id","npc_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "research" (
	"owner_id" text NOT NULL,
	"research_id" text NOT NULL,
	"status" text DEFAULT 'locked' NOT NULL,
	"completes_at" timestamp with time zone,
	CONSTRAINT "research_owner_id_research_id_pk" PRIMARY KEY("owner_id","research_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"scope" text NOT NULL,
	"scope_key" text NOT NULL,
	"state" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"correlation_id" text,
	"timer_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "build_queue_owner_idx" ON "build_queue" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "events_event_id_uq" ON "events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_type_idx" ON "events" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_correlation_idx" ON "events" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_actor_idx" ON "ledger" USING btree ("actor_kind","actor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_cause_idx" ON "ledger" USING btree ("cause_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wfi_scope_idx" ON "workflow_instances" USING btree ("workflow_id","scope","scope_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wfi_timer_idx" ON "workflow_instances" USING btree ("timer_at");