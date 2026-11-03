import { allowedEdits, editDistance, fold, isCyrillic, phonetic } from "./text";

export const STOPWORDS = new Set(
  (
    "a an the do does did you have has any got is are was there what which how much many cost costs price prices " +
    "of for in on at to me i we my your our it its this that these those please show shows find looking look " +
    "want need can could would like some with and or buy order purchase get stock available availability " +
    "call size sizes tell about about from by be am just also pair pairs pcs piece pieces item items thanks thank " +
    "у вас есть ли покажи покажите показать найди найдите ищу ищем хочу хотел хотела нужен нужна нужно нужны " +
    "сколько стоит стоят цена цены цену какая какой какие какое наличии наличие в на для по и или мне можно " +
    "пожалуйста купить куплю заказать заказ размер размеры это эти та то там что где как не а но с со из " +
    "от до вы ты мы я он она они их ваш ваши шт штук пара пар спасибо подскажите скажите размера размере размеров " +
    "бар ма ме ба бе па пе сізде сізде менде маған бізге керек қанша бағасы бағасын бағасы баға бағалары тұрады " +
    "өлшем өлшемі өлшемдері өлшемін қандай қайда және мен үшін болады алғым келеді қалай берші көрсетші көрсетіңіз " +
    "көрсет көрсетіңізші тауар тауарлар тауарды рахмет сәлем толығырақ айтып беріңіз дана жұп өлшемде немесе да де"
  ).split(/\s+/),
);

export function stem(word: string): string {
  if (/[а-яё]/.test(word)) {
    if (word.length >= 6) return word.slice(0, -2);
    if (word.length === 5) return word.slice(0, -1);
    return word;
  }
  return word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word;
}

export function searchTerms(text: string): string[] {
  const terms: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}-]+/u)) {
    const word = raw.replace(/^-+|-+$/g, "");
    if (word.length < 2 || STOPWORDS.has(word) || /^\d+$/.test(word)) continue;
    const term = stem(word);
    if (!terms.includes(term)) terms.push(term);
  }
  return terms.slice(0, 6);
}

export const RU_EN: [string, string[]][] = [
  ["кроссов", ["sneaker", "shoe"]],
  ["кед", ["sneaker", "shoe"]],
  ["кросс", ["sneaker", "shoe"]],
  ["демисез", ["demi"]],
  ["осенн", ["demi"]],
  ["весенн", ["demi"]],
  ["унисекс", ["unisex"]],
  ["күзгі", ["demi"]],
  ["көктемгі", ["demi"]],
  ["ботин", ["boot", "shoe"]],
  ["сапог", ["boot"]],
  ["туфл", ["shoe"]],
  ["сандал", ["sandal"]],
  ["босонож", ["sandal"]],
  ["лофер", ["loafer"]],
  ["обув", ["shoe"]],
  ["бег", ["running"]],
  ["детск", ["kids"]],
  ["женск", ["women"]],
  ["мужск", ["men"]],
  ["зимн", ["winter"]],
  ["летн", ["summer"]],
  ["кожан", ["leather"]],
  ["стриж", ["haircut"]],
  ["бород", ["beard"]],
  ["брит", ["shave"]],
  ["окраш", ["coloring"]],
  ["укладк", ["styling"]],
  ["красн", ["red"]],
  ["син", ["blue"]],
  ["голуб", ["blue"]],
  ["зелен", ["green"]],
  ["черн", ["black"]],
  ["бел", ["white"]],
  ["сер", ["gray"]],
  ["желт", ["yellow"]],
  ["коричн", ["brown"]],
  ["бежев", ["beige"]],
  ["розов", ["pink"]],
  ["оранж", ["orange"]],
  ["фиолет", ["purple"]],
  ["кроссовка", ["sneaker", "shoe"]],
  ["етік", ["boot"]],
  ["аяқ киім", ["shoe"]],
  ["аяқ", ["shoe"]],
  ["сандал", ["sandal"]],
  ["балалар", ["kids"]],
  ["әйелдер", ["women"]],
  ["ерлер", ["men"]],
  ["қысқы", ["winter"]],
  ["жазғы", ["summer"]],
  ["былғары", ["leather"]],
  ["сақал", ["beard"]],
  ["қызыл", ["red"]],
  ["жасыл", ["green"]],
  ["сары", ["yellow"]],
  ["қоңыр", ["brown"]],
  ["сұр", ["gray"]],
  ["қара", ["black"]],
  ["көк", ["blue"]],
];

export function translateTerm(term: string): string[] | null {
  const t = term.replace(/ё/g, "е");
  if (!/[а-я]/.test(t)) return null;
  for (const [key, english] of RU_EN) {
    if (t.startsWith(key) && t.length <= key.length + (key.length >= 5 ? 5 : 2)) return english;
  }
  return null;
}

export function englishTerms(terms: string[]): { primary: string[]; all: string[] } {
  const primary: string[] = [];
  const all: string[] = [];
  for (const term of terms) {
    const english = translateTerm(term);
    const first = english?.[0] ?? term;
    if (!primary.includes(first)) primary.push(first);
    for (const word of english ?? [term]) if (!all.includes(word)) all.push(word);
  }
  return { primary, all };
}

export type Facet = "color" | "gender" | "season";

const COLOR_WORDS = [
  "black",
  "white",
  "red",
  "blue",
  "green",
  "yellow",
  "brown",
  "beige",
  "pink",
  "orange",
  "purple",
  "gray",
];

const FACET_ALIASES: Record<string, string> = {
  grey: "gray",
  violet: "purple",
  mens: "men",
  man: "men",
  male: "men",
  gents: "men",
  womens: "women",
  woman: "women",
  ladies: "women",
  lady: "women",
  female: "women",
  kid: "kids",
  child: "kids",
  children: "kids",
  boy: "kids",
  boys: "kids",
  girl: "kids",
  girls: "kids",
  junior: "kids",
  youth: "kids",
  spring: "demi",
  autumn: "demi",
  fall: "demi",
  demi: "demi",
};

const FACET_OF: Record<string, Facet> = {
  ...Object.fromEntries(COLOR_WORDS.map((word) => [word, "color" as const])),
  men: "gender",
  women: "gender",
  kids: "gender",
  winter: "season",
  summer: "season",
  demi: "season",
};

/** The canonical facet word for an English word, if it names a color, gender or season. */
export function facetOf(word: string): { facet: Facet; canon: string } | null {
  const bare = word.replace(/'s$/, "");
  const canon = FACET_ALIASES[bare] ?? bare;
  const facet = FACET_OF[canon];
  return facet ? { facet, canon } : null;
}

const ENGLISH_SYNONYMS: Record<string, string[]> = {
  trainer: ["sneaker", "shoe"],
  kick: ["sneaker", "shoe"],
  footwear: ["shoe"],
  slipper: ["sandal"],
  flipflop: ["sandal"],
  barber: ["haircut"],
};

export function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:ches|shes|sses|xes)$/.test(word)) return word.slice(0, -2);
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

export type MatchKind = "exact" | "sound" | "typo";

export interface BuiltinHit {
  words: string[];
  kind: MatchKind;
}

interface IndexedKey {
  key: string;
  words: string[];
  sound: string;
}

let keyIndex: IndexedKey[] | null = null;

function builtinKeys(): IndexedKey[] {
  keyIndex ??= RU_EN.filter(([key]) => key.length >= 4).map(([key, words]) => ({
    key,
    words,
    sound: phonetic(key),
  }));
  return keyIndex;
}

/** Looks a shopper's word up in the built-in en/ru/kk dictionary, tolerating transliteration and typos. */
export function builtinLookup(rawToken: string): BuiltinHit | null {
  const token = fold(rawToken).replace(/'s$/, "");
  if (!token) return null;

  const english = ENGLISH_SYNONYMS[singular(token)];
  if (english) return { words: english, kind: "exact" };

  const exact = translateTerm(token);
  if (exact) return { words: exact, kind: "exact" };
  if (
    /^[a-z]+$/.test(token) &&
    !isCyrillic(token) &&
    (facetOf(singular(token)) || token.length < 4)
  ) {
    return null;
  }

  const sound = phonetic(token);
  if (sound.length < 3) return null;
  for (const entry of builtinKeys()) {
    if (sound.startsWith(entry.sound) && sound.length <= entry.sound.length + 5) {
      return { words: entry.words, kind: "sound" };
    }
  }
  let best: { entry: IndexedKey; gap: number } | null = null;
  for (const entry of builtinKeys()) {
    const allowed = Math.max(allowedEdits(entry.sound.length), 1);
    if (allowed === 0 || sound[0] !== entry.sound[0]) continue;
    for (const length of [entry.sound.length - 1, entry.sound.length, entry.sound.length + 1]) {
      if (length < 1 || length > sound.length) continue;
      const gap = editDistance(sound.slice(0, length), entry.sound, allowed);
      if (gap <= allowed && (best === null || gap < best.gap)) best = { entry, gap };
    }
  }
  return best ? { words: best.entry.words, kind: "typo" } : null;
}
