CREATE TABLE IF NOT EXISTS "blueprint_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"cost_gold" bigint DEFAULT 0 NOT NULL,
	"base_ms" bigint DEFAULT 300000 NOT NULL
);
