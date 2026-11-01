CREATE TYPE "public"."actor" AS ENUM('owner', 'business_agent', 'customer_agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."agent_name" AS ENUM('business', 'customer');--> statement-breakpoint
CREATE TYPE "public"."api_key_kind" AS ENUM('owner', 'customer_agent');--> statement-breakpoint
CREATE TYPE "public"."availability" AS ENUM('in_stock', 'out_of_stock', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."change_set_status" AS ENUM('pending', 'applied', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."conversation_channel" AS ENUM('workspace', 'storefront', 'external_agent');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('new', 'in_progress', 'completed');--> statement-breakpoint
CREATE TYPE "public"."draft_status" AS ENUM('draft', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."inquiry_status" AS ENUM('new', 'in_progress', 'completed');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('system', 'user', 'assistant', 'tool');--> statement-breakpoint
CREATE TYPE "public"."offer_kind" AS ENUM('product', 'service', 'other');--> statement-breakpoint
CREATE TYPE "public"."offer_status" AS ENUM('active', 'draft', 'archived');--> statement-breakpoint
CREATE TYPE "public"."order_source" AS ENUM('storefront', 'external_agent');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('draft', 'submitted', 'received', 'processing', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."price_status" AS ENUM('confirmed', 'on_request');--> statement-breakpoint
CREATE TYPE "public"."source_asset_status" AS ENUM('uploaded', 'processing', 'extracted', 'failed');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('draft', 'live');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner');--> statement-breakpoint
CREATE TABLE "agent_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent" "agent_name" NOT NULL,
	"model" text NOT NULL,
	"prompt_overrides" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "api_key_kind" NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor" "actor" NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_model_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "draft_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_profiles" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text,
	"contacts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"policies" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"missing_info" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ops" jsonb NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"status" "change_set_status" DEFAULT 'pending' NOT NULL,
	"requested_by" "actor" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent" "agent_name" NOT NULL,
	"channel" "conversation_channel" NOT NULL,
	"status" "conversation_status" DEFAULT 'new' NOT NULL,
	"session_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inquiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid,
	"subject" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"contact" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "inquiry_status" DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text,
	"tool_calls" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offer_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"kind" "offer_kind" NOT NULL,
	"attribute_schema" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"offer_type_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"price" numeric(12, 2),
	"currency" text,
	"price_status" "price_status" NOT NULL,
	"availability" "availability" DEFAULT 'unknown' NOT NULL,
	"status" "offer_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid,
	"items" jsonb NOT NULL,
	"contact" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "order_status" DEFAULT 'draft' NOT NULL,
	"source" "order_source" NOT NULL,
	"idempotency_key" text NOT NULL,
	"total" numeric(12, 2),
	"currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "source_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"filename" text NOT NULL,
	"storage_path" text NOT NULL,
	"extracted_text" text,
	"status" "source_asset_status" DEFAULT 'uploaded' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" "tenant_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_model_drafts" ADD CONSTRAINT "business_model_drafts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_sets" ADD CONSTRAINT "change_sets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_types" ADD CONSTRAINT "offer_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_offer_type_id_offer_types_id_fk" FOREIGN KEY ("offer_type_id") REFERENCES "public"."offer_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_assets" ADD CONSTRAINT "source_assets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_configs_tenant_idx" ON "agent_configs" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_configs_tenant_agent_uq" ON "agent_configs" USING btree ("tenant_id","agent");--> statement-breakpoint
CREATE INDEX "api_keys_tenant_idx" ON "api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "audit_events_tenant_idx" ON "audit_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "business_model_drafts_tenant_idx" ON "business_model_drafts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "change_sets_tenant_idx" ON "change_sets" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "conversations_tenant_idx" ON "conversations" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_tenant_channel_session_uq" ON "conversations" USING btree ("tenant_id","channel","session_key");--> statement-breakpoint
CREATE INDEX "inquiries_tenant_idx" ON "inquiries" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_tenant_idx" ON "notifications" USING btree ("tenant_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_tenant_kind_ref_uq" ON "notifications" USING btree ("tenant_id","kind","ref_id");--> statement-breakpoint
CREATE INDEX "offer_types_tenant_idx" ON "offer_types" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_types_tenant_key_uq" ON "offer_types" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "offers_tenant_idx" ON "offers" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "offers_tenant_status_idx" ON "offers" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "orders_tenant_idx" ON "orders" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tenant_idempotency_uq" ON "orders" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "source_assets_tenant_idx" ON "source_assets" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "users_tenant_idx" ON "users" USING btree ("tenant_id");