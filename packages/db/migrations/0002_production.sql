ALTER TABLE "blueprint_catalog" ADD COLUMN "produces" jsonb;--> statement-breakpoint
ALTER TABLE "blueprint_catalog" ADD COLUMN "max_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "blueprint_catalog" ADD COLUMN "unlock_item" text;--> statement-breakpoint
ALTER TABLE "build_queue" ADD COLUMN "last_collected_at" timestamp with time zone;--> statement-breakpoint
-- Hand-added backfill: buildings completed before production existed start
-- accruing from the moment this migration runs, not from their completion
-- (which would hand every early player a full store on their first /collect).
UPDATE "build_queue" SET "last_collected_at" = now() WHERE "status" = 'completed' AND "last_collected_at" IS NULL;
