CREATE TABLE IF NOT EXISTS "bids" (
	"id" text PRIMARY KEY NOT NULL,
	"offer_id" text NOT NULL,
	"bidder_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bids_offer_status_idx" ON "bids" USING btree ("offer_id","status");