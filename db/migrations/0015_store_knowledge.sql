CREATE TABLE "store_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"offer_id" uuid,
	"model" text,
	"text" text NOT NULL,
	"source_inquiry_id" uuid,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_profiles" ADD COLUMN "vocabulary_manual" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "intent_events" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "intent_events" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "store_notes" ADD CONSTRAINT "store_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_notes" ADD CONSTRAINT "store_notes_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_notes" ADD CONSTRAINT "store_notes_source_inquiry_id_inquiries_id_fk" FOREIGN KEY ("source_inquiry_id") REFERENCES "public"."inquiries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "store_notes_tenant_idx" ON "store_notes" USING btree ("tenant_id","answered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "store_notes_inquiry_idx" ON "store_notes" USING btree ("source_inquiry_id");