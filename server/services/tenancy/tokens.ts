import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type ApiKeyKind = "owner" | "customer_agent";

const KEY_PREFIX: Record<ApiKeyKind, string> = { owner: "sk_own_", customer_agent: "sk_cus_" };

export function generateApiKey(kind: ApiKeyKind): { raw: string; hash: string; prefix: string } {
  const raw = `${KEY_PREFIX[kind]}${randomBytes(24).toString("base64url")}`;
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 12) };
}

/** API keys are high-entropy, so a fast hash is enough and allows lookup by hash. */
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface SessionClaims {
  userId: string;
  tenantId: string;
  /** Expiry, seconds since epoch. */
  exp: number;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signSession(claims: SessionClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySession(
  token: string,
  secret: string,
  now: number = Date.now(),
): SessionClaims | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;

  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof claims !== "object" ||
    claims === null ||
    typeof (claims as SessionClaims).userId !== "string" ||
    typeof (claims as SessionClaims).tenantId !== "string" ||
    typeof (claims as SessionClaims).exp !== "number"
  ) {
    return null;
  }
  const typed = claims as SessionClaims;
  return typed.exp * 1000 > now ? typed : null;
}

/** URL-safe slug from a business name; non-Latin names fall back to "store". */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length >= 3 ? slug : "store";
}
