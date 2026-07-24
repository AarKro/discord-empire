CREATE INDEX IF NOT EXISTS "ledger_reason_idx" ON "ledger" USING btree ("reason");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "offers_board_idx" ON "offers" USING btree ("kind","status","guild_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wfi_active_idx" ON "workflow_instances" USING btree ("status","workflow_id");