CREATE TYPE "public"."proposal_run_status" AS ENUM('pending', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "proposal_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" "proposal_run_status" DEFAULT 'pending' NOT NULL,
	"draft_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proposal_runs" ADD CONSTRAINT "proposal_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_runs" ADD CONSTRAINT "proposal_runs_draft_id_business_model_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."business_model_drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposal_runs_tenant_idx" ON "proposal_runs" USING btree ("tenant_id");