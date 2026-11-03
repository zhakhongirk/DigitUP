export function fold(word: string): string {
  return word.toLowerCase().replace(/ё/g, "е");
}

export function isCyrillic(word: string): boolean {
  return /[а-яёәғқңөұүһі]/i.test(word);
}

const TO_LATIN: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
  ә: "a",
  ғ: "g",
  қ: "q",
  ң: "n",
  ө: "o",
  ұ: "u",
  ү: "u",
  һ: "h",
  і: "i",
};

export function toLatin(word: string): string {
  let out = "";
  for (const char of fold(word)) out += TO_LATIN[char] ?? char;
  return out;
}

/**
 * A script-independent spelling used to compare words typed in Cyrillic or in
 * Latin letters: transliteration, then merged look-alike sounds and doubled letters.
 */
export function phonetic(word: string): string {
  return toLatin(word)
    .replace(/[^a-z0-9]/g, "")
    .replace(/sch/g, "sh")
    .replace(/kh/g, "h")
    .replace(/zh/g, "j")
    .replace(/ts/g, "c")
    .replace(/ch/g, "c")
    .replace(/sh/g, "s")
    .replace(/q/g, "k")
    .replace(/x/g, "ks")
    .replace(/w/g, "v")
    .replace(/y/g, "i")
    .replace(/ck/g, "k")
    .replace(/c/g, "k")
    .replace(/(.)\1+/g, "$1");
}

/** Edit distance with adjacent swaps counted as one edit; gives up above `limit`. */
export function editDistance(a: string, b: string, limit = 3): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows.push(new Array<number>(b.length + 1).fill(0));
    rows[i]![0] = i;
  }
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      }
      rows[i]![j] = best;
    }
  }
  return rows[a.length]![b.length]!;
}

/** Typos allowed in a word of this length. */
export function allowedEdits(length: number): number {
  if (length >= 9) return 2;
  if (length >= 5) return 1;
  return 0;
}
