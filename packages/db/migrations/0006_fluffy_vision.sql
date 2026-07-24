CREATE TABLE IF NOT EXISTS "research_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"cost_gold" bigint DEFAULT 0 NOT NULL,
	"base_ms" bigint DEFAULT 300000 NOT NULL,
	"prereqs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"grants_blueprints" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "research" ADD COLUMN "correlation_id" text;