export type SizeSystem = "eu" | "us" | "uk" | "cm";

export interface SizeGrid {
  /** Attribute that holds the sizes. */
  key: string;
  system: SizeSystem | "letter";
  /** Sizes the catalog uses, as stored. */
  values: string[];
}

export interface SizeSpec {
  /** The size as the shopper wrote it. */
  raw: string;
  /** Null when the shopper gave a bare number. */
  system: SizeSystem | null;
  values: number[];
  letter?: string;
}

const MEN_US_OFFSET = 33;
const WOMEN_US_OFFSET = 30.5;
const MEN_UK_OFFSET = 34;
const WOMEN_UK_OFFSET = 32.5;

function roundHalf(value: number): number {
  return Math.round(value * 2) / 2;
}

export function toEu(value: number, system: SizeSystem, women = false): number {
  switch (system) {
    case "eu":
      return value;
    case "us":
      return value + (women ? WOMEN_US_OFFSET : MEN_US_OFFSET);
    case "uk":
      return value + (women ? WOMEN_UK_OFFSET : MEN_UK_OFFSET);
    case "cm":
      return Math.round((value + 1.17) * 1.5);
  }
}

export function fromEu(eu: number, system: SizeSystem, women = false): number {
  switch (system) {
    case "eu":
      return eu;
    case "us":
      return roundHalf(eu - (women ? WOMEN_US_OFFSET : MEN_US_OFFSET));
    case "uk":
      return roundHalf(eu - (women ? WOMEN_UK_OFFSET : MEN_UK_OFFSET));
    case "cm":
      return roundHalf((eu * 2) / 3 - 1.17);
  }
}

/** The system a bare number most likely belongs to. */
export function guessSystem(value: number): SizeSystem | null {
  if (value >= 24 && value <= 50) return "eu";
  if (value >= 2 && value < 24) return "us";
  return null;
}

export function formatSize(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function conversions(eu: number, women = false): Record<SizeSystem, string> {
  return {
    eu: formatSize(eu),
    us: formatSize(fromEu(eu, "us", women)),
    uk: formatSize(fromEu(eu, "uk", women)),
    cm: formatSize(fromEu(eu, "cm", women)),
  };
}

const TOLERANCE = 0.75;

export type SizeResolution =
  { ok: true; values: string[] } | { ok: false; reason: "grid_unknown" | "not_a_size" };

/** Maps the shopper's size onto the sizes the store actually lists. */
export function resolveSize(spec: SizeSpec, grid: SizeGrid | null, women: boolean): SizeResolution {
  if (!grid) return { ok: false, reason: "grid_unknown" };
  if (grid.system === "letter") {
    const wanted = spec.letter?.toUpperCase();
    const found = wanted ? grid.values.find((v) => v.toUpperCase() === wanted) : undefined;
    return found ? { ok: true, values: [found] } : { ok: false, reason: "grid_unknown" };
  }
  if (spec.letter || spec.values.length === 0) return { ok: false, reason: "grid_unknown" };

  const system = spec.system ?? guessSystem(spec.values[0]!);
  if (!system) return { ok: false, reason: "not_a_size" };
  const stored = grid.values
    .map((value) => ({ value, number: Number(value.replace(",", ".")) }))
    .filter((entry) => Number.isFinite(entry.number));

  const out: string[] = [];
  for (const raw of spec.values) {
    const wanted = fromEu(toEu(raw, system, women), grid.system, women);
    let best: { value: string; gap: number } | null = null;
    for (const entry of stored) {
      const gap = Math.abs(entry.number - wanted);
      if (gap <= TOLERANCE && (best === null || gap <= best.gap))
        best = { value: entry.value, gap };
    }
    const value = best?.value ?? formatSize(wanted);
    if (!out.includes(value)) out.push(value);
  }
  return { ok: true, values: out };
}

/** Which unit the catalog's numeric sizes are written in. */
export function inferGridSystem(values: string[], keyName: string): SizeGrid["system"] | null {
  const numbers = values
    .map((v) => Number(v.replace(",", ".")))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (numbers.length === 0) {
    return values.length > 0 && values.every((v) => /^(?:x{0,3}s|m|l|x{0,3}l)$/i.test(v))
      ? "letter"
      : null;
  }
  if (/(?:^|_)(?:cm|см)(?:$|_)/i.test(keyName)) return "cm";
  const median = numbers[Math.floor(numbers.length / 2)]!;
  if (median >= 24) return "eu";
  if (median >= 2) return "us";
  return null;
}
