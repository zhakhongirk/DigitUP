const NOUNS: [string, string[]][] = [
  [
    "shoe",
    [
      "кроссов",
      "кеды",
      "кедов",

      "обув",
      "ботин",
      "туфл",
      "сапог",
      "сандал",
      "слипон",
      "лофер",
      "мокасин",
      "угг",
      "балетк",
      "тапоч",
      "шлепан",
      "аяқ",
      "кроссовк",
      "шаруа",
      "етік",
      "sneaker",
      "shoe",
      "boot",
      "footwear",
      "sandal",
      "loafer",
      "slipper",
      "trainer",
      "heel",
    ],
  ],
  ["bag", ["сумк", "рюкзак", "портфел", "барсетк", "клатч", "қапшық", "bag", "backpack", "purse"]],
  ["dress", ["платье", "сарафан", "көйлек", "dress", "gown"]],
  [
    "jacket",
    ["куртк", "пальто", "пуховик", "плащ", "жилет", "бомбер", "күртеше", "jacket", "coat"],
  ],
  [
    "shirt",
    [
      "футбол",
      "рубаш",
      "худи",
      "свитер",
      "толстовк",
      "кофт",
      "блуз",
      "майк",
      "поло",
      "джемпер",
      "жейде",
      "shirt",
      "hoodie",
      "sweater",
      "tee",
      "top",
    ],
  ],
  ["pants", ["брюк", "джинс", "штан", "шорт", "леггин", "шалбар", "pants", "jeans", "trouser"]],
  [
    "clothing",
    ["одежд", "костюм", "киім", "clothing", "clothes", "apparel", "garment", "wear", "outfit"],
  ],
  ["hat", ["кепк", "шапк", "панам", "бейсболк", "тақия", "hat", "cap", "beanie"]],
  ["watch", ["часы", "часов", "сағат", "watch"]],
  ["glasses", ["очки", "көзілдірік", "glasses", "sunglasses"]],
  ["bottle", ["бутыл", "бөтелке", "термос", "bottle", "flask"]],
  ["phone", ["телефон", "смартфон", "айфон", "iphone", "phone", "smartphone"]],
  ["laptop", ["ноутбук", "laptop", "notebook"]],
  ["cup", ["чашк", "кружк", "стакан", "кесе", "cup", "mug"]],
  ["box", ["короб", "қорап", "box", "package"]],
];

const GENERIC_TYPES = new Set(["product", "products", "item", "items", "offer", "goods"]);
const FALLBACKS = ["shoe", "bag", "bottle", "box"];
const MAX_CONCEPTS = 4;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((word) => word.length > 1);
}

export function englishNoun(text: string): string | null {
  for (const word of words(text)) {
    for (const [noun, stems] of NOUNS) {
      if (stems.some((stem) => (stem.length <= 3 ? word === stem : word.startsWith(stem)))) {
        return noun;
      }
    }
  }
  return null;
}

function plainEnglish(text: string): boolean {
  return /^[a-z]+(?: [a-z]+)?$/i.test(text);
}

/** What to look for in the photo: simple English nouns first, since the model only knows those. */
export function photoConcepts(offer: {
  offerTypeKey: string;
  category?: string | null;
  title: string;
}): string[] {
  const type = offer.offerTypeKey.replace(/[_-]+/g, " ").trim();
  const sources = [
    GENERIC_TYPES.has(type.toLowerCase()) ? "" : type,
    offer.category ?? "",
    offer.title,
  ]
    .map((source) => source.trim())
    .filter(Boolean);
  const mapped = sources.map(englishNoun).filter((noun): noun is string => noun !== null);
  const raw = sources.filter(plainEnglish);
  return [...new Set([...mapped, ...raw, ...FALLBACKS])].slice(0, MAX_CONCEPTS);
}
