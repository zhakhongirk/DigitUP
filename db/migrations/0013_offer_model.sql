ALTER TABLE "offers" ADD COLUMN "model" text;--> statement-breakpoint
CREATE INDEX "offers_tenant_model_idx" ON "offers" USING btree ("tenant_id","model");