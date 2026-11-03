DROP INDEX "conversations_tenant_idx";--> statement-breakpoint
DROP INDEX "inquiries_tenant_idx";--> statement-breakpoint
DROP INDEX "orders_tenant_idx";--> statement-breakpoint
DROP INDEX "offers_tenant_status_idx";--> statement-breakpoint
CREATE INDEX "conversations_tenant_updated_idx" ON "conversations" USING btree ("tenant_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversations_tenant_agent_created_idx" ON "conversations" USING btree ("tenant_id","agent","created_at");--> statement-breakpoint
CREATE INDEX "inquiries_tenant_created_idx" ON "inquiries" USING btree ("tenant_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inquiries_tenant_status_idx" ON "inquiries" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "orders_tenant_created_idx" ON "orders" USING btree ("tenant_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_tenant_status_idx" ON "orders" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "offers_tenant_status_idx" ON "offers" USING btree ("tenant_id","status","title");