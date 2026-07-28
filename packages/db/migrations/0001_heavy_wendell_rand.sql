CREATE TABLE IF NOT EXISTS "battles" (
	"id" text PRIMARY KEY NOT NULL,
	"dispatch_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"encounter_id" text NOT NULL,
	"seed" text NOT NULL,
	"outcome" text NOT NULL,
	"rounds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"loot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"thread_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dispatches" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"mission" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"force" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"origin_guild_id" text,
	"status" text DEFAULT 'travelling' NOT NULL,
	"arrives_at" timestamp with time zone,
	"returns_at" timestamp with time zone,
	"correlation_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "encounter_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"unit_type" text NOT NULL,
	"atk" integer DEFAULT 0 NOT NULL,
	"def" integer DEFAULT 0 NOT NULL,
	"hp" integer DEFAULT 0 NOT NULL,
	"tier" integer DEFAULT 1 NOT NULL,
	"travel_ms" bigint DEFAULT 300000 NOT NULL,
	"loot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reward_gold" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "units" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"kind" text DEFAULT 'troop' NOT NULL,
	"unit_type" text NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL,
	"atk" integer DEFAULT 0 NOT NULL,
	"def" integer DEFAULT 0 NOT NULL,
	"hp" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'training' NOT NULL,
	"ready_at" timestamp with time zone,
	"position_guild_id" text,
	"position_district_id" text,
	"correlation_id" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "battles_owner_idx" ON "battles" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "battles_dispatch_idx" ON "battles" USING btree ("dispatch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dispatches_due_idx" ON "dispatches" USING btree ("status","arrives_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "units_owner_status_idx" ON "units" USING btree ("owner_id","status");