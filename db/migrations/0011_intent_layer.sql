CREATE TABLE "intent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"session_key" text,
	"client_key" text,
	"text" text NOT NULL,
	"applied" jsonb,
	"relaxed" jsonb,
	"result_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verdict" text,
	"comment" text,
	"after_intent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_profiles" ADD COLUMN "vocabulary" jsonb;--> statement-breakpoint
ALTER TABLE "intent_events" ADD CONSTRAINT "intent_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intent_events_tenant_idx" ON "intent_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "intent_events_session_idx" ON "intent_events" USING btree ("tenant_id","session_key","created_at");--> statement-breakpoint
CREATE INDEX "intent_events_client_idx" ON "intent_events" USING btree ("tenant_id","client_key","created_at");--> statement-breakpoint
CREATE INDEX "intent_events_after_idx" ON "intent_events" USING btree ("after_intent_id");