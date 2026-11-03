const SAFE_PATH = /^\/(?![\/\\])[^\r\n\t\\]*$/;

export function safeNext(value: FormDataEntryValue | null, fallback = "/app"): string {
  return typeof value === "string" && SAFE_PATH.test(value) ? value : fallback;
}
