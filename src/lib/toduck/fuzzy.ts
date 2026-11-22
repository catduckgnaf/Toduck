/**
 * Typo-tolerant similarity scoring for Toduck natural-language entry.
 *
 * A TypeScript port of the deterministic, stdlib-only scorer from Print
 * Handy (`print_handy/core/fuzzy.py`, issue #468), adapted to Toduck
 * tasks. The bands mean the same thing here as there:
 *
 * - `score >= HIGH_CONFIDENCE` (85): a high-confidence near-match.
 * - `FUZZY_FLOOR <= score < HIGH_CONFIDENCE` (65-84): suggestion
 *   material - fit for a "Did you mean ...?" or a pick-list, never for
 *   acting on.
 * - `score < FUZZY_FLOOR`: not a match; the function returns 0.
 *
 * The score is the whole-string ratio of the normalized strings
 * (difflib `SequenceMatcher` ratio: twice the matching characters over
 * the combined length), plus a token-coverage guard: at least half of
 * the query's words must each have a plausible partner (ratio >= 65)
 * among the target's words, or the score is 0. A fuzzy score never
 * reaches 100: exact is a separate tier owned by each caller, and a
 * fuzzy match by itself never applies anything - callers present it
 * for a pick or a confirmation that names the resolved target.
 *
 * `decide` is the shared confidence/conflict policy: a top hit is
 * "direct" - clear enough to be the single offered answer - only at or
 * above `HIGH_CONFIDENCE` with a margin of at least `CLEAR_MARGIN`
 * points over the runner-up. Anything else that scores is "suggest"
 * material for a pick-list.
 *
 * Deterministic and local-first: no network, no AI, no dependencies.
 */

export const FUZZY_FLOOR = 65;
export const HIGH_CONFIDENCE = 85;
export const CLEAR_CONFIDENCE = HIGH_CONFIDENCE;
export const CLEAR_MARGIN = 10;

const MAX_WINDOW_TARGET_TOKENS = 32;
const MAX_WINDOW_QUERY_TOKENS = 16;
const MAX_COVERAGE_QUERY_TOKENS = 16;
const MAX_COVERAGE_TARGET_TOKENS = 32;
const TOKEN_MATCH_FLOOR = 82;

/**
 * The one text fold every matcher uses. Lowercases, decomposes (NFKD)
 * and strips combining marks so accented letters fold to their base
 * letters, then keeps letters and digits of any script and turns
 * everything else into spaces.
 */
export function norm(text: string): string {
  const folded = (text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
  return [...folded]
    .map((ch) => (/[\p{L}\p{N}]/u.test(ch) || ch === " " ? ch : " "))
    .join("")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

// ---------------------------------------------------------------- numbers

const UNIT_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TEN_WORDS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const ORDINAL_UNIT_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
};
const ORDINAL_TEN_WORDS: Record<string, number> = {
  twentieth: 20,
  thirtieth: 30,
  fortieth: 40,
  fiftieth: 50,
  sixtieth: 60,
  seventieth: 70,
  eightieth: 80,
  ninetieth: 90,
};
export const NUMBER_WORDS: Record<string, number> = {
  ...UNIT_WORDS,
  ...TEN_WORDS,
  ...ORDINAL_UNIT_WORDS,
  ...ORDINAL_TEN_WORDS,
  hundred: 100,
  thousand: 1000,
  hundredth: 100,
  thousandth: 1000,
};

/**
 * (value, next index) for the number phrase at `start`, or null.
 * Handles cardinals and ordinals alike - both canonicalize to the same
 * digits ("twenty first" and "twenty one" both become 21) - with
 * hundred/thousand multipliers and a skipped "and".
 */
export function parseNumberPhrase(tokens: string[], start: number): [number, number] | null {
  let total = 0;
  let current = 0;
  let seen = false;
  let i = start;
  while (i < tokens.length) {
    const token = tokens[i] ?? "";
    if (
      token === "and" &&
      seen &&
      i + 1 < tokens.length &&
      tokens[i + 1] !== undefined &&
      tokens[i + 1] in NUMBER_WORDS
    ) {
      i += 1;
      continue;
    }
    if (token === "hundred" || token === "hundredth") {
      current = (current || 1) * 100;
    } else if (token === "thousand" || token === "thousandth") {
      total += (current || 1) * 1000;
      current = 0;
    } else if (token in NUMBER_WORDS) {
      current += NUMBER_WORDS[token] ?? 0;
    } else {
      break;
    }
    seen = true;
    i += 1;
  }
  if (!seen) return null;
  return [total + current, i];
}

// ------------------------------------------- Toduck vocabulary (adapted)

/**
 * Compound phrases users type both joined and spaced. Keys are token
 * pairs, values the joined form both sides fold to.
 */
export const PHRASE_FORMS: Record<string, string> = {
  "every day": "everyday",
  "every week": "everyweek",
  "every month": "everymonth",
  "every year": "everyyear",
  "next week": "nextweek",
  "next month": "nextmonth",
  "next year": "nextyear",
  "this week": "thisweek",
  "this month": "thismonth",
  "this weekend": "thisweekend",
  "next weekend": "nextweekend",
  "every other": "everyother",
  "high priority": "highpriority",
  "low priority": "lowpriority",
  "medium priority": "mediumpriority",
};

/**
 * Single-token equivalents: abbreviations and short forms for the
 * date, repeat and priority words the parser understands.
 */
export const TOKEN_FORMS: Record<string, string> = {
  tmrw: "tomorrow",
  tmr: "tomorrow",
  tod: "today",
  yday: "yesterday",
  wk: "week",
  wks: "week",
  mo: "month",
  yr: "year",
  mon: "monday",
  tue: "tuesday",
  tues: "tuesday",
  wed: "wednesday",
  thu: "thursday",
  thur: "thursday",
  thurs: "thursday",
  fri: "friday",
  sat: "saturday",
  sun: "sunday",
  everyday: "every day",
  everyweek: "every week",
  everymonth: "every month",
  everyyear: "every year",
  nextweek: "next week",
  nextmonth: "next month",
  thisweek: "this week",
  thismonth: "this month",
  thisweekend: "this weekend",
  nextweekend: "next weekend",
};

/**
 * Curated single-token misspellings of the date and repeat words.
 * The edit-distance correction below covers most typos generically;
 * this table pins the common ones, including first-letter slips the
 * correction pass refuses.
 */
export const TYPO_FORMS: Record<string, string> = {
  tommorow: "tomorrow",
  tommoroww: "tomorrow",
  tomorow: "tomorrow",
  tommorrow: "tomorrow",
  tommrow: "tomorrow",
  tomoroww: "tomorrow",
  todai: "today",
  tody: "today",
  tooday: "today",
  yestarday: "yesterday",
  yesterdy: "yesterday",
  yestday: "yesterday",
  wensday: "wednesday",
  wendsday: "wednesday",
  wednsday: "wednesday",
  thrusday: "thursday",
  thursdayy: "thursday",
  tuseday: "tuesday",
  tuesdayy: "tuesday",
  mondy: "monday",
  mondayy: "monday",
  firday: "friday",
  fridy: "friday",
  saterday: "saturday",
  saturady: "saturday",
  sundy: "sunday",
  wek: "week",
  wekk: "week",
  mounth: "month",
  mnth: "month",
  daliy: "daily",
  dayly: "daily",
  weekley: "weekly",
  weekely: "weekly",
  monthley: "monthly",
  monthy: "monthly",
  evrey: "every",
  everyy: "every",
  repete: "repeat",
  repat: "repeat",
  anual: "annual",
  yearley: "yearly",
  priorty: "priority",
  prioroty: "priority",
  urget: "urgent",
  urgt: "urgent",
  hgh: "high",
  medum: "medium",
};

/** Misspellings typed with a space in the wrong place. */
export const TYPO_PHRASES: Record<string, string> = {
  "to morrow": "tomorrow",
  "to day": "today",
  "every day": "everyday",
  "every week": "everyweek",
};

/** Legitimate words that sit near the parser vocabulary. */
export const REAL_WORDS: ReadonlySet<string> = new Set([
  ...Object.keys(NUMBER_WORDS),
  "today",
  "tomorrow",
  "yesterday",
  "tonight",
  "weekend",
  "weekday",
  "weekdays",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "every",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "repeat",
  "repeats",
  "next",
  "this",
  "last",
  "other",
  "first",
  "second",
  "third",
  "high",
  "medium",
  "low",
  "urgent",
  "priority",
  "morning",
  "afternoon",
  "evening",
  "noon",
  "midnight",
  // Real words one edit from a vocabulary word: never "correct" these.
  // "weakly" is not a typo of "weekly", "dairy"/"dally" are not "daily",
  // "dearly"/"nearly" are not "yearly", "toady" is not "today", and a
  // "sundae" is not a "sunday".
  "weakly",
  "dairy",
  "dally",
  "dearly",
  "nearly",
  "toady",
  "sundae",
]);

// ------------------------------------------------------------ misspellings

function typoTokens(tokens: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const pair = `${tokens[i] ?? ""} ${tokens[i + 1] ?? ""}`;
    const phrase = i + 1 < tokens.length ? TYPO_PHRASES[pair] : undefined;
    if (phrase) {
      out.push(...phrase.split(" "));
      i += 2;
      continue;
    }
    const mapped = TYPO_FORMS[tokens[i] ?? ""] ?? tokens[i] ?? "";
    out.push(...mapped.split(" "));
    i += 1;
  }
  return out;
}

/**
 * Damerau-Levenshtein (optimal string alignment) distance, or
 * `limit + 1` past `limit`. A swap of two neighbouring letters is one
 * edit, so "shrnik" is one edit from "shrink".
 */
export function editDistance(a: string, b: string, limit: number): number {
  if (a === b) return 0;
  const lenA = a.length;
  const lenB = b.length;
  if (Math.abs(lenA - lenB) > limit) return limit + 1;
  if (!lenA) return lenB;
  if (!lenB) return lenA;
  const inf = limit + 1;
  let prev2: number[] | null = null;
  let prev: number[] = Array.from({ length: lenB + 1 }, (_, j) => (j <= limit ? j : inf));
  for (let i = 1; i <= lenA; i++) {
    const cur: number[] = new Array<number>(lenB + 1).fill(inf);
    if (i <= limit) cur[0] = i;
    const jStart = Math.max(1, i - limit);
    const jEnd = Math.min(lenB, i + limit);
    for (let j = jStart; j <= jEnd; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(
        (prev[j] ?? inf) + 1,
        (cur[j - 1] ?? inf) + 1,
        (prev[j - 1] ?? inf) + cost,
      );
      if (prev2 !== null && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, (prev2[j - 2] ?? inf) + 1);
      }
      cur[j] = val;
    }
    let rowMin = inf;
    for (let j = jStart; j <= jEnd; j++) rowMin = Math.min(rowMin, cur[j] ?? inf);
    if (rowMin > limit) return limit + 1;
    prev2 = prev;
    prev = cur;
  }
  const res = prev[lenB] ?? inf;
  return res <= limit ? res : limit + 1;
}

/** Edits tolerated for one token: none up to 4 letters, 1 for 5 to 7, 2 for 8 to 40, none beyond 40. */
export function typoLimit(token: string): number {
  if (token.length <= 4 || token.length > 40) return 0;
  return token.length <= 7 ? 1 : 2;
}

function correctable(token: string): boolean {
  return /^[a-z]+$/.test(token) && !REAL_WORDS.has(token) && typoLimit(token) > 0;
}

/**
 * The one vocabulary word `token` is a bounded misspelling of, else
 * `token`. The first letter must match, the distance must be within
 * `typoLimit`, and the nearest word must be unique: two vocabulary
 * words at the same distance are a genuine ambiguity, so the token is
 * left alone and the caller's normal scoring (and pick list) decides.
 */
export function correctToken(token: string, vocabulary: Iterable<string>): string {
  const words = new Set(vocabulary);
  if (words.has(token) || !correctable(token)) return token;
  const limit = typoLimit(token);
  let best: string | null = null;
  let bestDistance = limit + 1;
  let tied = false;
  for (const word of words) {
    if (!word || word[0] !== token[0] || word.length > 40 || !/^[a-z]+$/.test(word)) continue;
    const distance = editDistance(token, word, limit);
    if (distance < bestDistance) {
      best = word;
      bestDistance = distance;
      tied = false;
    } else if (distance === bestDistance && word !== best) {
      tied = true;
    }
  }
  if (best === null || tied) return token;
  return best;
}

export function correctTokens(tokens: string[], vocabulary: Iterable<string>): string[] {
  const words = new Set(vocabulary);
  return tokens.map((token) => correctToken(token, words));
}

// ---------------------------------------------------------------- stemming

function undouble(stem: string): string {
  if (
    stem.length >= 2 &&
    stem[stem.length - 1] === stem[stem.length - 2] &&
    !"aeiou".includes(stem[stem.length - 1] ?? "")
  ) {
    return stem.slice(0, -1);
  }
  return stem;
}

/**
 * Fold simple plurals and -ing/-ed verb forms to the base word.
 * Applied to both sides of every comparison, so a fold only has to be
 * consistent, not a perfect stemmer.
 */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("es") && /(s|x|z|ch|sh)$/.test(token.slice(0, -2))) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith("s") && !/(ss|us|is)$/.test(token)) {
    return token.slice(0, -1);
  }
  if (token.length > 5 && token.endsWith("ing") && token.slice(0, -3).length >= 4) {
    return undouble(token.slice(0, -3));
  }
  if (token.length > 4 && token.endsWith("ed")) return undouble(token.slice(0, -2));
  return token;
}

/**
 * `norm` plus the scoring canonicalization, as a single string. Number
 * phrases and digit tokens become plain digits, known compound phrases
 * join, abbreviation tokens map to their long form, and the remaining
 * tokens are stemmed. Used only inside fuzzy scoring - callers' exact
 * tiers never see this form.
 */
export function canonical(text: string): string {
  const tokens = typoTokens(norm(text).split(" "));
  // A number word joined to the word it counts ("firstlayer",
  // "twentyone") splits back apart so the phrase parser below can
  // read it; both sides fold identically, so this only equates the
  // joined and spaced spellings of the same words.
  const splitTokens: string[] = [];
  for (const token of tokens) {
    const prefix = Object.keys(NUMBER_WORDS)
      .filter((word) => token.length > word.length + 1 && token.startsWith(word) && token !== word)
      .sort((a, b) => b.length - a.length)[0];
    if (prefix) splitTokens.push(prefix, token.slice(prefix.length));
    else splitTokens.push(token);
  }
  // Compound phrases first: none of them contain number words.
  const phrases: string[] = [];
  let i = 0;
  while (i < splitTokens.length) {
    const pair = `${splitTokens[i] ?? ""} ${splitTokens[i + 1] ?? ""}`;
    const joined = i + 1 < splitTokens.length ? PHRASE_FORMS[pair] : undefined;
    if (joined) {
      phrases.push(joined);
      i += 2;
    } else {
      phrases.push(splitTokens[i] ?? "");
      i += 1;
    }
  }
  const out: string[] = [];
  i = 0;
  while (i < phrases.length) {
    const token = phrases[i] ?? "";
    const ordinal = /^(\d+)(st|nd|rd|th)$/.exec(token) ?? /^v(\d+)$/.exec(token);
    if (ordinal) {
      out.push(String(Number.parseInt(ordinal[1] ?? "0", 10)));
      i += 1;
      continue;
    }
    if (/^\d+$/.test(token)) {
      out.push(String(Number.parseInt(token, 10)));
      i += 1;
      continue;
    }
    const phrase = parseNumberPhrase(phrases, i);
    if (phrase !== null) {
      out.push(String(phrase[0]));
      i = phrase[1];
      continue;
    }
    out.push(stem(TOKEN_FORMS[token] ?? token));
    i += 1;
  }
  return out.join(" ");
}

// ------------------------------------------------------------- phonetics

function phonetic(token: string): string {
  let out = token.replace(/ph/g, "f");
  out = out.replace(/tion/g, "shun").replace(/sion/g, "zhun");
  out = out.replace(/ough/g, "uf");
  out = out.replace(/c(?=[aou])/g, "k");
  out = out.replace(/zh/g, "sh");
  out = out.replace(/^wh/, "w");
  out = out.replace(/^wr/, "r");
  out = out.replace(/ck/g, "k");
  out = out.replace(/lite/g, "light");
  out = out.replace(/brite/g, "bright");
  return out;
}

// ---------------------------------------------------------------- scoring

/**
 * difflib `SequenceMatcher` ratio, ported faithfully: twice the
 * matching characters (longest-match blocks, found recursively) over
 * the combined length. Operates on code points so astral characters
 * count once.
 */
export function sequenceMatcherRatio(a: string, b: string): number {
  const aChars = [...a];
  const bChars = [...b];
  if (aChars.length === 0 && bChars.length === 0) return 1;
  if (aChars.length === 0 || bChars.length === 0) return 0;
  const b2j = new Map<string, number[]>();
  bChars.forEach((ch, j) => {
    const arr = b2j.get(ch);
    if (arr) arr.push(j);
    else b2j.set(ch, [j]);
  });
  const blocks = matchingBlocks(aChars, bChars, b2j);
  const matches = blocks.reduce((sum, block) => sum + block.size, 0);
  return (2 * matches) / (aChars.length + bChars.length);
}

type MatchBlock = { aLow: number; bLow: number; size: number };

function findLongestMatch(
  a: string[],
  aLow: number,
  aHigh: number,
  b: string[],
  bLow: number,
  bHigh: number,
  b2j: Map<string, number[]>,
): MatchBlock {
  let bestI = aLow;
  let bestJ = bLow;
  let bestSize = 0;
  let j2len = new Map<number, number>();
  for (let i = aLow; i < aHigh; i++) {
    const newJ2len = new Map<number, number>();
    for (const j of b2j.get(a[i] ?? "") ?? []) {
      if (j < bLow) continue;
      if (j >= bHigh) break;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      newJ2len.set(j, k);
      if (k > bestSize) {
        bestI = i - k + 1;
        bestJ = j - k + 1;
        bestSize = k;
      }
    }
    j2len = newJ2len;
  }
  return { aLow: bestI, bLow: bestJ, size: bestSize };
}

function matchingBlocks(a: string[], b: string[], b2j: Map<string, number[]>): MatchBlock[] {
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  const blocks: MatchBlock[] = [];
  while (queue.length > 0) {
    const [aLow, aHigh, bLow, bHigh] = queue.pop() ?? [0, 0, 0, 0];
    const match = findLongestMatch(a, aLow, aHigh, b, bLow, bHigh, b2j);
    if (match.size > 0) {
      blocks.push(match);
      if (aLow < match.aLow && bLow < match.bLow) {
        queue.push([aLow, match.aLow, bLow, match.bLow]);
      }
      if (match.aLow + match.size < aHigh && match.bLow + match.size < bHigh) {
        queue.push([match.aLow + match.size, aHigh, match.bLow + match.size, bHigh]);
      }
    }
  }
  blocks.sort((x, y) => x.aLow - y.aLow || x.bLow - y.bLow || x.size - y.size);
  // Collapse adjacent blocks.
  const collapsed: MatchBlock[] = [];
  let prev: MatchBlock | null = null;
  for (const block of blocks) {
    if (
      prev !== null &&
      prev.aLow + prev.size === block.aLow &&
      prev.bLow + prev.size === block.bLow
    ) {
      const merged: MatchBlock = { aLow: prev.aLow, bLow: prev.bLow, size: prev.size + block.size };
      prev = merged;
      collapsed[collapsed.length - 1] = merged;
    } else {
      prev = { ...block };
      collapsed.push(prev);
    }
  }
  return collapsed;
}

function covered(queryTokens: string[], targetTokens: string[]): boolean {
  const q = queryTokens.slice(0, MAX_COVERAGE_QUERY_TOKENS);
  const t = targetTokens.slice(0, MAX_COVERAGE_TARGET_TOKENS);
  if (q.length === 0 || t.length === 0) return false;
  const coveredCount = q.filter((word) =>
    t.some((other) => sequenceMatcherRatio(word, other) * 100 >= FUZZY_FLOOR),
  ).length;
  return coveredCount * 2 >= q.length;
}

function scoreFolded(q: string, t: string): number {
  if (!q || !t) return 0;
  const score = Math.round(sequenceMatcherRatio(q, t) * 100);
  if (score < FUZZY_FLOOR || !covered(q.split(" "), t.split(" "))) return 0;
  return Math.min(score, 99);
}

/**
 * Similarity of one query to one target, 0 or 65-99. Both sides are
 * canonicalized first. Returns 0 when either side is empty, the ratio
 * falls below `FUZZY_FLOOR`, or the token-coverage guard rejects the
 * pair as a false friend. When the plain pass returns 0, a phonetic
 * rescue pass gets one chance to lift a spelling-by-ear pair; it never
 * lowers or alters a score the plain pass produced.
 */
export function fuzzyScore(query: string, target: string): number {
  const q0 = canonical(query);
  const t = canonical(target);
  if (!q0 || !t) return 0;
  // Bounded typo tolerance against this target's own words: a
  // misspelled query word becomes the target word it is clearly a
  // misspelling of, never a different valid word.
  const q = correctTokens(q0.split(" "), t.split(" ")).join(" ");
  const score = scoreFolded(q, t);
  if (score !== 0) return score;
  const pq = q
    .split(" ")
    .map((token) => phonetic(token))
    .join(" ");
  const pt = t
    .split(" ")
    .map((token) => phonetic(token))
    .join(" ");
  if (pq === q && pt === t) return 0;
  return scoreFolded(pq, pt);
}

/** The best `fuzzyScore` of a query over a candidate's names/aliases. */
export function bestFuzzyScore(query: string, targets: Iterable<string>): number {
  let best = 0;
  for (const target of targets) best = Math.max(best, fuzzyScore(query, target));
  return best;
}

/**
 * Best `fuzzyScore` of a query against a target or a word window of
 * it, for long candidate names where the query names only part of the
 * name. Capped, so keyword-stuffed targets fall back to the
 * whole-string score instead of burning CPU per candidate.
 */
export function windowedFuzzyScore(query: string, target: string): number {
  const q = canonical(query);
  const t = canonical(target);
  if (!q || !t) return 0;
  let best = fuzzyScore(q, t);
  const qTokens = q.split(" ");
  const tTokens = t.split(" ");
  if (
    tTokens.length > 1 &&
    tTokens.length <= MAX_WINDOW_TARGET_TOKENS &&
    qTokens.length <= MAX_WINDOW_QUERY_TOKENS
  ) {
    for (const size of new Set([qTokens.length - 1, qTokens.length, qTokens.length + 1])) {
      if (size < 1 || size >= tTokens.length) continue;
      for (let start = 0; start <= tTokens.length - size; start++) {
        best = Math.max(best, fuzzyScore(q, tTokens.slice(start, start + size).join(" ")));
      }
    }
  }
  return best;
}

/**
 * The best (score, word) of any single query token against a word
 * list. For short verbs and keywords: "tommorow" has to find
 * "tomorrow" without the rest of the sentence dragging the
 * whole-string ratio under the floor. Words of three letters or fewer
 * match exactly only, because one typo in a short word is another
 * word. The floor sits above the general one so a near miss such as
 * "sink" for "shrink" (80) is not a match. Returns (0, null) when
 * nothing reaches the floor; ties keep the earlier word.
 */
export function tokenMatch(
  query: string,
  words: Iterable<string>,
  floor: number = TOKEN_MATCH_FLOOR,
): [number, string | null] {
  let best: [number, string | null] = [0, null];
  const tokens = canonical(query).split(" ");
  for (const word of words) {
    const target = canonical(word);
    for (const token of tokens) {
      const score =
        target.length <= 3 || token.length <= 3
          ? token === target
            ? 99
            : 0
          : fuzzyScore(token, target);
      if (score >= floor && score > best[0]) best = [score, word];
    }
  }
  return best;
}

// ----------------------------------------------------------------- policy

export type Decision<T> = {
  kind: "direct" | "suggest" | "none";
  best: T | null;
  contenders: T[];
};

/**
 * Apply the confidence/conflict policy to (score, payload) pairs.
 * Scores are `fuzzyScore` integers; anything below `FUZZY_FLOOR` is
 * not a candidate. Direct requires the top score at or above
 * `CLEAR_CONFIDENCE` *and* a margin of at least `CLEAR_MARGIN` over
 * the runner-up - a tie is the extreme conflict and is never direct.
 * Ranking is by score descending and stable, so equal scores keep the
 * caller's order: deterministic, no coin flips. This governs
 * fuzzy-band results only; exact matches are the callers' own tier
 * and never pass through here.
 */
export function decide<T>(scored: [number, T][]): Decision<T> {
  const ranked = scored.filter(([score]) => score >= FUZZY_FLOOR).sort((a, b) => b[0] - a[0]);
  if (ranked.length === 0) return { kind: "none", best: null, contenders: [] };
  const [topScore, top] = ranked[0] as [number, T];
  const contenders = ranked
    .filter(([score]) => topScore - score < CLEAR_MARGIN)
    .map(([, payload]) => payload);
  if (topScore >= CLEAR_CONFIDENCE && contenders.length === 1) {
    return { kind: "direct", best: top, contenders: [top] };
  }
  return { kind: "suggest", best: top, contenders };
}
