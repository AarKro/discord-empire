CREATE TABLE IF NOT EXISTS "continent_discoveries" (
	"player_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "continent_discoveries_player_id_guild_id_pk" PRIMARY KEY("player_id","guild_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "continent_roles" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"citizen_role_id" text,
	"observer_role_id" text
);
