import { describe, expect, it } from "vitest";
import {
  buildPhotoTargets,
  compactKey,
  groupByTarget,
  matchPhotoFiles,
  nameVariants,
  type PhotoTarget,
} from "@/server/owner/photo-match";

const offers = [
  { id: "1", title: "Stride Runner 41", model: "Stride Runner", attributes: { sku: "SR-41" } },
  { id: "2", title: "Stride Runner 42", model: "Stride Runner", attributes: { sku: "SR-42" } },
  { id: "3", title: "Trail King 40", model: "Trail King", attributes: {} },
  { id: "4", title: "Sport Sandal", model: null, attributes: { article: 7731 } },
  { id: "5", title: "Хит Кроссовки", model: "Хит Кроссовки", attributes: {} },
];
const targets = buildPhotoTargets(offers);
const match = (file: string) => matchPhotoFiles([file], targets)[0]!;

describe("buildPhotoTargets", () => {
  it("adds one model target per model and one target per offer", () => {
    expect(targets.filter((t) => t.kind === "model").map((t) => t.label)).toEqual([
      "Stride Runner",
      "Trail King",
      "Хит Кроссовки",
    ]);
    expect(targets.filter((t) => t.kind === "offer")).toHaveLength(5);
  });

  it("reads the code from sku-like attributes", () => {
    expect(targets.find((t) => t.key === "o:4")?.sku).toBe("7731");
    expect(targets.find((t) => t.key === "o:1")?.sku).toBe("SR-41");
    expect(targets.find((t) => t.key === "o:3")?.sku).toBeNull();
  });
});

describe("compactKey", () => {
  it("ignores case, separators and punctuation", () => {
    expect(compactKey("Stride_Runner-X")).toBe(compactKey("stride runner x"));
    expect(compactKey("  A.B ")).toBe("ab");
  });

  it("maps Cyrillic to Latin", () => {
    expect(compactKey("Хит")).toBe("hit");
    expect(compactKey("Қазақ")).toBe("kazak");
  });
});

describe("nameVariants", () => {
  it("strips the extension and trailing indexes", () => {
    expect(nameVariants("shoe-2.JPG")).toEqual(["shoe-2", "shoe"]);
    expect(nameVariants("shoe_1.png")).toEqual(["shoe_1", "shoe"]);
    expect(nameVariants("shoe (3).webp")).toEqual(["shoe (3)", "shoe"]);
    expect(nameVariants("shoe copy.jpg")).toEqual(["shoe copy", "shoe"]);
    expect(nameVariants("folder/shoe.jpeg")).toEqual(["shoe"]);
  });
});

describe("matchPhotoFiles", () => {
  it("matches a model by exact name", () => {
    expect(match("Stride Runner.jpg")).toEqual({
      status: "matched",
      key: "m:Stride Runner",
      candidates: ["m:Stride Runner"],
    });
  });

  it("matches with dashes, underscores and case", () => {
    expect(match("stride-runner.jpg").key).toBe("m:Stride Runner");
    expect(match("STRIDE_RUNNER.PNG").key).toBe("m:Stride Runner");
    expect(match("stride__runner.webp").key).toBe("m:Stride Runner");
  });

  it("ignores trailing index suffixes", () => {
    for (const name of [
      "stride-runner-2.jpg",
      "stride_runner_1.jpg",
      "Stride Runner (3).jpg",
      "stride-runner-img-4.jpg",
      "stride runner copy.jpg",
    ]) {
      expect(match(name).key).toBe("m:Stride Runner");
    }
  });

  it("prefers a model over an offer", () => {
    expect(match("trail-king.jpg").key).toBe("m:Trail King");
  });

  it("matches an offer title when no model matches", () => {
    expect(match("stride-runner-42.jpg").key).toBe("o:2");
    expect(match("sport_sandal.jpg").key).toBe("o:4");
  });

  it("matches a SKU last", () => {
    expect(match("SR-41.jpg").key).toBe("o:1");
    expect(match("7731.jpg").key).toBe("o:4");
    expect(match("sr41-2.jpg").key).toBe("o:1");
  });

  it("matches Cyrillic and Latin spellings", () => {
    expect(match("хит кроссовки.jpg").key).toBe("m:Хит Кроссовки");
    expect(match("hit-krossovki.jpg").key).toBe("m:Хит Кроссовки");
  });

  it("reports names that match nothing", () => {
    expect(match("IMG_0001.jpg")).toEqual({ status: "none", key: null, candidates: [] });
    expect(match("random.jpg").status).toBe("none");
  });

  it("reports ambiguous names with every candidate", () => {
    const two: PhotoTarget[] = [
      { key: "o:a", kind: "offer", label: "Cap", sku: null },
      { key: "o:b", kind: "offer", label: "cap", sku: null },
    ];
    const result = matchPhotoFiles(["cap.jpg"], two)[0]!;
    expect(result.status).toBe("ambiguous");
    expect(result.candidates).toEqual(["o:a", "o:b"]);
    expect(result.key).toBe("o:a");
  });

  it("keeps the input order and one result per file", () => {
    const results = matchPhotoFiles(["trail-king-1.jpg", "nope.jpg", "trail-king-2.jpg"], targets);
    expect(results.map((r) => r.key)).toEqual(["m:Trail King", null, "m:Trail King"]);
  });

  it("does not match an empty stem", () => {
    expect(match(".jpg").status).toBe("none");
  });
});

describe("groupByTarget", () => {
  it("groups in order and drops unmatched rows", () => {
    const groups = groupByTarget([
      { key: "m:a", file: "a-1" },
      { key: null, file: "x" },
      { key: "m:b", file: "b" },
      { key: "m:a", file: "a-2" },
    ]);
    expect([...groups.keys()]).toEqual(["m:a", "m:b"]);
    expect(groups.get("m:a")?.map((row) => row.file)).toEqual(["a-1", "a-2"]);
  });
});
