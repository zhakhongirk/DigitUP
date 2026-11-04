ALTER TABLE "intent_events" ADD COLUMN "rewrite" jsonb;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "ms" integer;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "path" text DEFAULT 'loop' NOT NULL;