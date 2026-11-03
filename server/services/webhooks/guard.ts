import { lookup as dnsLookup, promises as dns } from "node:dns";
import { isIP } from "node:net";

export class WebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookUrlError";
  }
}

function ipv4Octets(address: string): number[] | null {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts
    : null;
}

function isPrivateV4(address: string): boolean {
  const o = ipv4Octets(address);
  if (!o) return true;
  const [a, b, c] = o as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function expandV6(address: string): number[] | null {
  let text = address.split("%")[0]!.toLowerCase();
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const o = ipv4Octets(tail[1]!);
    if (!o) return null;
    const hi = ((o[0]! << 8) | o[1]!).toString(16);
    const lo = ((o[2]! << 8) | o[3]!).toString(16);
    text = `${text.slice(0, -tail[1]!.length)}${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves[1] ? halves[1].split(":") : [];
  const compressed = halves.length === 2;
  const missing = 8 - head.length - rest.length;
  if (compressed ? missing < 0 : head.length !== 8) return null;
  const groups = [...head, ...Array<string>(compressed ? missing : 0).fill("0"), ...rest];
  const words = groups.map((g) => parseInt(g, 16));
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff)
    ? words
    : null;
}

function isPrivateV6(address: string): boolean {
  const w = expandV6(address);
  if (!w) return true;
  const embedded = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (w.slice(0, 5).every((x) => x === 0) && (w[5] === 0xffff || w[5] === 0)) {
    if (w[5] === 0 && w[6] === 0 && w[7]! <= 1) return true;
    return isPrivateV4(embedded(w[6]!, w[7]!));
  }
  if (w[0] === 0x64 && w[1] === 0xff9b) return isPrivateV4(embedded(w[6]!, w[7]!));
  if (w[0] === 0x2002) return isPrivateV4(embedded(w[1]!, w[2]!));
  return (w[0]! & 0xfe00) === 0xfc00 || (w[0]! & 0xffc0) === 0xfe80 || (w[0]! & 0xff00) === 0xff00;
}

/** True for loopback, private, link-local, multicast and other non-public addresses. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateV4(address);
  if (version === 6) return isPrivateV6(address);
  return true;
}

export type Resolver = (host: string) => Promise<string[]>;

export const systemResolver: Resolver = async (host) => {
  const found = await dns.lookup(host, { all: true });
  return found.map((entry) => entry.address);
};

/** Checks that need no network: https only, no credentials, no private IP literal. */
export function parseWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new WebhookUrlError("The webhook URL is not valid");
  }
  if (url.protocol !== "https:") throw new WebhookUrlError("The webhook URL must use https");
  if (url.username || url.password) {
    throw new WebhookUrlError("The webhook URL must not contain credentials");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new WebhookUrlError("The webhook URL must point to a public host");
  }
  if (isIP(host) !== 0 && isPrivateAddress(host)) {
    throw new WebhookUrlError("The webhook URL must point to a public host");
  }
  return url;
}

/** Validates the URL and every address its host resolves to. */
export async function assertPublicWebhookUrl(
  raw: string,
  resolve: Resolver = systemResolver,
): Promise<URL> {
  const url = parseWebhookUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) return url;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new WebhookUrlError("The webhook host could not be resolved");
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new WebhookUrlError("The webhook URL must point to a public host");
  }
  return url;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;

/** Replacement for dns.lookup on the delivery connection: refuses non-public addresses at connect time. */
export function guardedLookup(
  host: string,
  options: { all?: boolean } | number | undefined,
  callback: LookupCallback,
): void {
  const all = typeof options === "object" && options?.all === true;
  dnsLookup(host, { all: true }, (error, addresses) => {
    if (error) return callback(error, "");
    const list = Array.isArray(addresses) ? addresses : [];
    if (list.length === 0 || list.some((entry) => isPrivateAddress(entry.address))) {
      return callback(new Error("Webhook host is not public"), "");
    }
    const first = list[0]!;
    if (all) return callback(null, list);
    return callback(null, first.address, first.family);
  });
}
