CREATE TABLE "kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "telegram_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "telegram_chat_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "telegram_link_code" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "telegram_link_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_telegram_link_code_unique" UNIQUE("telegram_link_code");