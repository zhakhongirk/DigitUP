import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from "playwright-core";
import { createDb } from "@/db/client";
import { tenants } from "@/db/schema";
import { RecordingEventPublisher } from "@/server/events/types";
import { createCatalogService } from "@/server/services/catalog";
import { createOrdersService } from "@/server/services/orders";
import { t as storeT } from "@/server/storefront/i18n";
import { translator } from "@/shared/owner-copy";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const LOG = process.env.SMOKE_DEV_LOG ?? "";
const SHOTS = process.env.SMOKE_SHOTS_DIR ?? join(tmpdir(), "smoke");
const SHEET = process.env.SMOKE_SHEET ?? join(SHOTS, "contact-sheet.jpg");
const PASSWORD = "demo-password-123";
const OWNER = { email: "owner@stride-shoes.demo", password: PASSWORD };
const STAMP = Date.now().toString(36);
const STAFF_EMAIL = `staff-${STAMP}@stride-shoes.demo`;
const ORDER_NAME = `Smoke ${STAMP}`;
const en = translator("en").t;

const results: { status: "PASS" | "FAIL" | "SKIP"; line: string }[] = [];
const issues = new Set<string>();

function report(status: "PASS" | "FAIL" | "SKIP", name: string, reason?: string) {
  const short = reason?.replace(/\s+/g, " ").slice(0, 200);
  const line = short ? `${status} ${name}: ${short}` : `${status} ${name}`;
  results.push({ status, line });
  console.log(line);
}

class Skip extends Error {}

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    report("PASS", name);
  } catch (error) {
    if (error instanceof Skip) report("SKIP", name, error.message);
    else report("FAIL", name, error instanceof Error ? error.message : String(error));
  }
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function watch(page: Page) {
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/Failed to load resource/.test(text)) return;
    issues.add(`console error on ${new URL(page.url()).pathname}: ${text.slice(0, 160)}`);
  });
  page.on("pageerror", (error) => {
    issues.add(`page error on ${new URL(page.url()).pathname}: ${error.message.slice(0, 160)}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      issues.add(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
    }
  });
}

async function open(
  browser: Browser,
  options: BrowserContextOptions = {},
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: BASE, locale: "en-US", ...options });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  watch(page);
  return { ctx, page };
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/signin");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/app/);
}

function devLog(): string {
  if (!LOG || !existsSync(LOG)) throw new Error("SMOKE_DEV_LOG is not set or missing");
  return readFileSync(LOG, "utf8");
}

async function linkFor(email: string, after: number): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const text = devLog().slice(after);
    const lines = text.split("\n").filter((l) => l.includes("mail.not_sent") && l.includes(email));
    const last = lines[lines.length - 1];
    const match = last?.match(/https?:\/\/[^\s"\\]+\/signin\/reset\?token=[^\s"\\]+/);
    if (match) return match[0];
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no mail link in dev log for ${email}`);
}

async function setPassword(page: Page, link: string, password: string) {
  await page.goto(link);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="confirm"]').fill(password);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/signin/reset"));
}

async function requestReset(page: Page, email: string): Promise<number> {
  const mark = devLog().length;
  await page.goto("/signin/forgot");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('form button[type="submit"]').click();
  await page.getByRole("status").first().waitFor();
  return mark;
}

async function seedOrder(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const handle = createDb(url);
  try {
    const [tenant] = await handle.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, "stride-shoes"));
    ensure(tenant, "tenant stride-shoes missing");
    const events = new RecordingEventPublisher();
    const ctx = { tenantId: tenant.id, actor: "customer_agent" as const };
    const catalog = createCatalogService({ db: handle.db, events });
    const orders = createOrdersService({ db: handle.db, events });
    const { items } = await catalog.searchOffers(ctx, { limit: 100 });
    const usable = items.filter((o) => o.price !== null && o.availability === "in_stock");
    ensure(usable.length >= 2, "fewer than two orderable offers");
    const [a, b] = usable;
    ensure(a && b, "offers missing");
    const { order } = await orders.createOrder(ctx, {
      idempotencyKey: `smoke-${STAMP}`,
      source: "storefront",
      items: [
        { offerId: a.id, quantity: 1, size: "42" },
        { offerId: b.id, quantity: 2, size: "44" },
      ],
      contact: { name: ORDER_NAME, phone: "+7 701 555 01 02" },
      fulfillment: "delivery",
      deliveryAddress: "Abay Ave 150",
      city: "Almaty",
    });
    await orders.submitOrder(ctx, order.id);
  } finally {
    await handle.close();
  }
}

async function chatBox(page: Page, lang: "en" | "kk" = "en") {
  const box = page.locator("#store-chat textarea").first();
  if (!(await box.isVisible())) {
    await page.locator(".sf-tabbar").getByText(storeT(lang, "tabChat"), { exact: true }).click();
  }
  return box;
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: "msedge" });
  } catch {
    return await chromium.launch({ channel: "chrome" });
  }
}

async function main() {
  const browser = await launch();
  const owner = await open(browser, { viewport: { width: 1280, height: 800 } });
  const op = owner.page;

  await check("owner sign-in", async () => {
    await signIn(op, OWNER.email, OWNER.password);
    ensure(op.url().includes("/app"), "not in /app");
  });

  const pages = [
    "/app",
    "/app/inbox",
    "/app/catalog",
    "/app/approvals",
    "/app/analytics",
    "/app/agents",
    "/app/audit",
    "/app/settings",
    "/app/notifications",
  ];
  for (const path of pages) {
    await check(`owner page ${path}`, async () => {
      const response = await op.goto(path);
      ensure(response && response.status() < 400, `status ${response?.status()}`);
      ensure(new URL(op.url()).pathname === path, `redirected to ${new URL(op.url()).pathname}`);
      await op.locator("h1, h2").first().waitFor();
    });
  }

  const store = await open(browser, { viewport: { width: 390, height: 844 } });
  const sp = store.page;
  let chatAvailable = false;

  await check("storefront loads", async () => {
    const response = await sp.goto("/s/stride-shoes");
    ensure(response && response.status() < 400, `status ${response?.status()}`);
    chatAvailable = await sp
      .locator("#store-chat textarea")
      .first()
      .isEnabled()
      .catch(() => false);
  });

  await check("chat product cards", async () => {
    if (!chatAvailable) throw new Skip("assistant unavailable (no LLM key in .env)");
    const box = await chatBox(sp);
    await box.fill("Show me running shoes");
    await box.press("Enter");
    const cards = sp.locator(".chat-offers .chat-offer");
    await cards.first().waitFor({ timeout: 90000 });
    const first = cards.first();
    ensure((await first.locator(".chat-offer-title").innerText()).trim(), "no title");
    ensure((await first.locator(".chat-offer-price").innerText()).trim(), "no price");
    ensure(await first.getByRole("link", { name: storeT("en", "viewOffer") }).count(), "no view");
    await shot(sp, "chat-cards");
  });

  let chatOrderPlaced = false;
  let orderTitles: string[] = [];
  let cardHeight = -1;
  await check("storefront order via chat", async () => {
    if (!chatAvailable) throw new Skip("assistant unavailable (no LLM key in .env)");
    const box = await chatBox(sp);
    const settle = async () => {
      await sp.waitForTimeout(1200);
      await sp.locator(".chat-typing").first().waitFor({ state: "detached", timeout: 90000 });
    };
    const lastReply = async () => {
      const all = await sp.locator(".chat-bubble-assistant").allInnerTexts();
      return all[all.length - 1] ?? "";
    };
    await box.fill("winter boots");
    await box.press("Enter");
    await settle();
    const add = sp
      .locator(".chat-offers")
      .last()
      .getByRole("button", { name: storeT("en", "addToOrder") });
    const answerSize = async () => {
      const size = (await lastReply()).match(/Available:\s*([^,.\s]+)/)?.[1];
      if (!size) return;
      await box.fill(`size ${size}`);
      await box.press("Enter");
      await settle();
    };
    ensure((await add.count()) >= 2, "need two product cards");
    const titles = await sp
      .locator(".chat-offers")
      .last()
      .locator(".chat-offer", { has: sp.getByRole("button", { name: storeT("en", "addToOrder") }) })
      .locator(".chat-offer-title")
      .allInnerTexts();
    await add.nth(0).click();
    await settle();
    await answerSize();
    await add.nth(1).click();
    await settle();
    await answerSize();
    const twoLines = await sp.locator(".chat-order").last().locator(".chat-order-lines li").count();
    ensure(twoLines >= 3, `card tap did not add a second line (${twoLines - 1} line(s))`);
    for (const title of titles.slice(0, 2)) {
      ensure(
        (await sp.locator(".chat-order").last().innerText()).includes(title.trim()),
        `order card misses ${title}: ${(await sp.locator(".chat-order").last().innerText()).replace(/\s+/g, " ")} | ${(await lastReply()).slice(0, 120)}`,
      );
    }
    orderTitles = titles.slice(0, 2).map((title) => title.trim());
    await sp
      .locator(".chat-order")
      .last()
      .getByRole("button", { name: storeT("en", "addAnother") })
      .dispatchEvent("click");
    await settle();
    await box.fill("Altai Women's Winter Boots");
    await box.press("Enter");
    await settle();
    await answerSize();
    const card = sp.locator(".chat-order").last();
    cardHeight = await card.evaluate((el) => el.getBoundingClientRect().height);
    const lines = await card.locator(".chat-order-lines li").count();
    ensure(lines >= 3, `order card has ${lines - 1} line(s): ${(await lastReply()).slice(0, 160)}`);
    await card.getByLabel(storeT("en", "fieldName")).fill(ORDER_NAME, { force: true });
    await card.getByLabel(storeT("en", "fieldPhone")).fill("+7 701 555 01 02", { force: true });
    await card
      .getByRole("button", { name: storeT("en", "delivery"), exact: true })
      .dispatchEvent("click");
    await card.getByLabel(storeT("en", "fieldCity")).fill("Almaty", { force: true });
    await card.getByLabel(storeT("en", "fieldAddress")).fill("Abay Ave 150", { force: true });
    await card.getByRole("button", { name: "Confirm order" }).dispatchEvent("click");
    await card.getByText(storeT("en", "orderSent")).waitFor();
    chatOrderPlaced = true;
  });

  await check("order card is visible in chat log", async () => {
    if (cardHeight < 0) throw new Skip("no order card was produced");
    ensure(cardHeight > 100, `order card height ${Math.round(cardHeight)}px inside .chat-log`);
  });

  await check("order with sizes and city in owner inbox", async () => {
    if (!chatOrderPlaced) await seedOrder();
    await op.setViewportSize({ width: 1280, height: 800 });
    await op.goto("/app/inbox");
    await op
      .getByRole("link", { name: new RegExp(ORDER_NAME) })
      .first()
      .click();
    await op.waitForURL(/item=/);
    const detail = op.locator("#detail");
    await detail.waitFor();
    const text = await detail.innerText();
    ensure((text.match(/size \S+/g) ?? []).length >= 2, "sizes missing");
    if (chatOrderPlaced) {
      for (const title of orderTitles) ensure(text.includes(title), `inbox order misses ${title}`);
    }
    ensure(text.includes("Almaty"), "city missing");
    await shot(op, "inbox-order");
    ensure(text.includes(en("ib.checkStock")), "check stock hint missing");
  });

  await check("analytics missed search", async () => {
    const q = "zzqx unicorn boots";
    const anon = await open(browser);
    try {
      for (let i = 0; i < 3; i++) {
        await anon.page.goto(`/s/stride-shoes?q=${encodeURIComponent(q)}`);
      }
    } finally {
      await anon.ctx.close();
    }
    await op.goto("/app/analytics");
    const card = op.locator("section", { hasText: en("an.missed") });
    ensure((await card.first().innerText()).includes(q), "query not listed");
  });

  await check("approvals reject confirm", async () => {
    await op.goto("/app/approvals");
    const boxes = op.locator('input[type="checkbox"]');
    if ((await boxes.count()) === 0) throw new Skip("no pending change set");
    await op
      .getByRole("button", { name: en("ap.reject"), exact: true })
      .first()
      .click();
    await op
      .getByRole("button", { name: en("ap.rejectCancel") })
      .first()
      .waitFor();
    await shot(op, "approvals-confirm");
  });

  await check("catalog needs-info chips", async () => {
    await op.goto("/app/catalog");
    const chip = op.getByRole("link", { name: en("ct.missingPhoto") });
    await chip.first().waitFor();
    await chip.first().click();
    await op.waitForURL(/missing=photo/);
  });

  await check("catalog edit form photo and sizes", async () => {
    await op.goto("/app/catalog");
    const toggle = op.locator(".ct-model-toggle").first();
    if (await toggle.count()) await toggle.click();
    await op.locator("table a").first().click();
    await op.waitForURL(/offer=/);
    await op.locator('input[name="imageUrl"]').waitFor();
    await op.locator('input[name="model"]').waitFor();
  });

  await check("audit actor chips", async () => {
    await op.goto("/app/audit");
    const nav = op.getByRole("navigation", { name: en("au.actorFilter") });
    ensure((await nav.getByRole("link").count()) >= 3, "too few chips");
    await op.goto("/app/audit?actor=system");
    ensure(op.url().includes("actor=system"), "actor param dropped");
    await op.getByRole("navigation", { name: en("au.actorFilter") }).waitFor();
  });

  await check("settings telegram, whatsapp, staff", async () => {
    await op.goto("/app/settings");
    await op.getByRole("heading", { name: en("st.tgTitle") }).waitFor();
    ensure(
      (await op.locator("#st-telegram").locator("xpath=..").innerText()).length > 0,
      "empty telegram block",
    );
    await op.getByText(en("st.tgOff")).waitFor();
    await op.getByLabel(en("f.whatsapp")).waitFor();
    await op.getByRole("heading", { name: en("st.staff"), exact: true }).waitFor();
  });

  await check("settings invalid whatsapp error", async () => {
    await op.goto("/app/settings");
    await op.getByLabel(en("f.whatsapp")).fill("not a number");
    await op
      .locator("#st-profile")
      .locator("xpath=ancestor::form")
      .locator("button")
      .last()
      .click();
    await op.getByText(en("st.errWhatsapp")).waitFor();
    await op.goto("/app/settings");
  });

  await check("staff invite, access limits, removal", async () => {
    const mark = devLog().length;
    await op.goto("/app/settings");
    await op.locator('input[name="email"][type="email"]').last().fill(STAFF_EMAIL);
    await op.getByRole("button", { name: en("st.staffInvite") }).click();
    await op.getByText(en("st.staffInvited")).waitFor();
    const link = await linkFor(STAFF_EMAIL, mark);
    const staff = await open(browser, { viewport: { width: 1280, height: 800 } });
    try {
      await setPassword(staff.page, link, PASSWORD);
      await signIn(staff.page, STAFF_EMAIL, PASSWORD);
      await staff.page.goto("/app/inbox");
      const nav = staff.page.locator(".ws-links");
      const hrefs = await nav
        .locator("a")
        .evaluateAll((els) => els.map((e) => e.getAttribute("href")));
      ensure(
        hrefs.includes("/app/inbox") && hrefs.includes("/app/catalog"),
        "inbox/catalog missing",
      );
      const banned = hrefs.filter((h) =>
        ["/app/settings", "/app/approvals", "/app/agents", "/app/audit"].includes(h ?? ""),
      );
      ensure(banned.length === 0, `staff nav shows ${banned.join(",")}`);
      for (const path of ["/app/settings", "/app/approvals", "/app/agents", "/app/audit"]) {
        await staff.page.goto(path);
        await staff.page
          .waitForURL((url) => url.pathname === "/app/inbox", { timeout: 8000 })
          .catch(() => {
            throw new Error(`${path} stays at ${new URL(staff.page.url()).pathname}`);
          });
      }
      await op.goto("/app/settings");
      const row = op.locator("form.st-actions").filter({ hasText: STAFF_EMAIL });
      await row.getByRole("button", { name: en("st.staffRemove") }).click();
      await op.getByText(STAFF_EMAIL).waitFor({ state: "detached" });
      await staff.page.goto("/app/inbox");
      await staff.page
        .waitForURL((url) => !url.pathname.startsWith("/app"), { timeout: 8000 })
        .catch(() => {
          throw new Error("staff session still valid after removal");
        });
    } finally {
      await staff.ctx.close();
    }
  });

  await check("password reset round trip", async () => {
    const email = "owner@fade-factory.demo";
    const temp = `Temp-${STAMP}-pass`;
    const a = await open(browser);
    try {
      const mark = await requestReset(a.page, email);
      await setPassword(a.page, await linkFor(email, mark), temp);
    } finally {
      await a.ctx.close();
    }
    const b = await open(browser);
    try {
      await signIn(b.page, email, temp);
      await b.ctx.clearCookies();
      const mark = await requestReset(b.page, email);
      await setPassword(b.page, await linkFor(email, mark), PASSWORD);
    } finally {
      await b.ctx.close();
    }
    const c = await open(browser);
    try {
      await signIn(c.page, email, PASSWORD);
    } finally {
      await c.ctx.close();
    }
  });

  await check("language kk owner", async () => {
    const kk = await open(browser, { viewport: { width: 1280, height: 800 } });
    try {
      await kk.ctx.addCookies([{ name: "lang", value: "kk", url: BASE }]);
      await signIn(kk.page, OWNER.email, OWNER.password);
      await kk.page.goto("/app/inbox");
      const kt = translator("kk").t;
      await kk.page.getByRole("heading", { name: kt("ib.title") }).waitFor();
      const pressed = await kk.page
        .locator('.lang-switch button[aria-pressed="true"]')
        .first()
        .innerText();
      ensure(pressed.includes("Қазақша"), `switch shows ${pressed}`);
    } finally {
      await kk.ctx.close();
    }
  });

  await check("language kk storefront", async () => {
    const kk = await open(browser, { locale: "kk-KZ", viewport: { width: 390, height: 844 } });
    try {
      await kk.ctx.addCookies([{ name: "lang", value: "kk", url: BASE }]);
      await kk.page.goto("/s/stride-shoes?q=zzqxnothing");
      await kk.page.getByText(storeT("kk", "nothingFound")).first().waitFor();
    } finally {
      await kk.ctx.close();
    }
  });

  await check("kk chat reply", async () => {
    if (!chatAvailable) throw new Skip("assistant unavailable (no LLM key in .env)");
    const kk = await open(browser, { locale: "kk-KZ", viewport: { width: 390, height: 844 } });
    try {
      await kk.page.goto("/s/stride-shoes");
      const box = await chatBox(kk.page, "kk");
      await box.fill("бағасы қанша");
      await box.press("Enter");
      const reply = kk.page.locator(".chat-bubble-assistant:not(.chat-dots)").last();
      await reply.waitFor({ timeout: 90000 });
      ensure(/[әғқңөұүһі]/i.test(await reply.innerText()), "no Kazakh letters");
    } finally {
      await kk.ctx.close();
    }
  });

  await check("mobile inbox detail screen", async () => {
    const m = await open(browser, { viewport: { width: 390, height: 844 } });
    try {
      await signIn(m.page, OWNER.email, OWNER.password);
      await m.page.goto("/app/inbox");
      const list = m.page.locator(".ib-list");
      await list.waitFor();
      await m.page
        .getByRole("link", { name: new RegExp(ORDER_NAME) })
        .first()
        .click();
      await m.page.waitForURL(/item=/);
      const back = m.page.getByRole("link", { name: en("ib.back") });
      await back.waitFor({ state: "visible" });
      ensure(!(await list.isVisible()), "list still visible beside detail");
      await shot(m.page, "inbox-mobile");
      await back.click();
      await list.waitFor({ state: "visible" });
    } finally {
      await m.ctx.close();
    }
  });

  if (!existsSync(join(SHOTS, "chat-cards.png"))) {
    const s = await open(browser, { viewport: { width: 390, height: 844 } });
    try {
      await s.page.goto("/s/stride-shoes");
      await shot(s.page, "chat-cards");
    } finally {
      await s.ctx.close();
    }
  }
  await contactSheet(browser);

  for (const issue of issues) report("FAIL", "page health", issue);
  await browser.close();

  const count = (s: string) => results.filter((r) => r.status === s).length;
  console.log(`\n${count("PASS")} passed, ${count("FAIL")} failed, ${count("SKIP")} skipped`);
  process.exit(count("FAIL") > 0 ? 1 : 0);
}

async function contactSheet(browser: Browser) {
  const names = ["inbox-mobile", "chat-cards", "inbox-order", "approvals-confirm"];
  const cells = names
    .filter((n) => existsSync(join(SHOTS, `${n}.png`)))
    .map((n) => {
      const data = readFileSync(join(SHOTS, `${n}.png`)).toString("base64");
      return `<img src="data:image/png;base64,${data}">`;
    });
  const html = `<style>body{margin:0;background:#222;display:grid;grid-template-columns:repeat(2,1fr);gap:8px;padding:8px;width:1384px}img{width:100%;height:auto;display:block}</style>${cells.join("")}`;
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.setContent(html);
  mkdirSync(dirname(SHEET), { recursive: true });
  writeFileSync(SHEET, await page.screenshot({ type: "jpeg", quality: 60, fullPage: true }));
  await ctx.close();
}

main().catch((error) => {
  console.error(`FAIL smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
