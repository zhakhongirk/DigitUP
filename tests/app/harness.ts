import { expect, vi } from "vitest";
import type { Services } from "@/server/container";
import { createApprovalsService } from "@/server/services/approvals";
import { createAuditService } from "@/server/services/audit";
import { createCatalogService } from "@/server/services/catalog";
import { createConversationsService } from "@/server/services/conversations";
import { createIngestionService } from "@/server/services/ingestion";
import { createNotificationsService } from "@/server/services/notifications";
import { createOrdersService } from "@/server/services/orders";
import { createTenancyService } from "@/server/services/tenancy";
import { createFileStorage } from "@/server/storage";
import { SESSION_COOKIE } from "@/server/mcp/http";
import type { TenantContext } from "@/server/services/context";
import type { BusinessModelInput } from "@/shared/business-model";
import { createWebhookService } from "@/server/services/webhooks";
import { createTelegramService } from "@/server/services/telegram";
import { recordingEvents, TEST_AUTH_SECRET, testDb, uniqueSlug } from "../helpers/db";

export const session = { token: null as string | null, cleared: false };
export const revalidate = vi.fn();

let services: Services | undefined;

export function testServices(): Services {
  if (!services) {
    const db = testDb();
    const events = recordingEvents();
    services = {
      tenancy: createTenancyService(db, { authSecret: TEST_AUTH_SECRET, bcryptRounds: 4 }),
      catalog: createCatalogService({ db, events }),
      orders: createOrdersService({ db, events }),
      conversations: createConversationsService({ db, events }),
      approvals: createApprovalsService(db),
      audit: createAuditService(db),
      ingestion: createIngestionService({ db, events, storage: createFileStorage() }),
      notifications: createNotificationsService(db),
      telegram: createTelegramService({ db, client: null, botUsername: null }),
      webhooks: createWebhookService(db),
    };
  }
  return services;
}

export function headersMock() {
  return {
    headers: async () => new Headers(),
    cookies: async () => ({
      get: (name: string) =>
        name === SESSION_COOKIE && session.token ? { name, value: session.token } : undefined,
      set: (name: string, value: string) => {
        if (name === SESSION_COOKIE) session.token = value;
      },
      delete: (name: string) => {
        if (name === SESSION_COOKIE) {
          session.token = null;
          session.cleared = true;
        }
      },
    }),
  };
}

export function containerMock() {
  return { getServices: async () => testServices() };
}

export function cacheMock() {
  return { revalidatePath: revalidate };
}

export function navigationMock() {
  return {
    redirect: (url: string) => {
      throw new Error(`REDIRECT:${url}`);
    },
  };
}

export function resetSession() {
  session.token = null;
  session.cleared = false;
  revalidate.mockClear();
}

export function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

export async function signUpOwner(): Promise<{ ctx: TenantContext; token: string }> {
  const { tenant, token } = await testServices().tenancy.signUp({
    businessName: `Owner ${uniqueSlug("b")}`,
    email: `${uniqueSlug("o")}@example.com`,
    password: "correct-horse",
  });
  const ctx = await testServices().tenancy.contextFromSession(token);
  if (!ctx || ctx.tenantId !== tenant.id) throw new Error("owner session did not resolve");
  return { ctx, token };
}

export const shopModel: BusinessModelInput = {
  profile: { name: "Shop" },
  offer_types: [{ key: "item", name: "Item", kind: "product", attributes: [] }],
  offers: [
    {
      title: "Alpha",
      offer_type: "item",
      price: 100,
      currency: "KZT",
      price_status: "confirmed",
      availability: "in_stock",
    },
    {
      title: "Beta",
      offer_type: "item",
      price: 200,
      currency: "KZT",
      price_status: "confirmed",
      availability: "in_stock",
    },
  ],
};

export async function seedShop(ctx: TenantContext): Promise<Record<string, string>> {
  const { catalog } = testServices();
  await catalog.applyBusinessModel(ctx, shopModel);
  const { items } = await catalog.searchOffers(ctx, { limit: 100 });
  return Object.fromEntries(items.map((o) => [o.title, o.id]));
}

export async function expectRedirect(promise: Promise<unknown>, url: string) {
  await expect(promise).rejects.toThrow(`REDIRECT:${url}`);
}
