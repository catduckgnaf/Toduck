/**
 * Natural-language task entry for Toduck (#108).
 *
 * Turns one line of typed text into a task draft: a title plus a date,
 * time, repeat, project, tag and priority, shown in an editable
 * preview before anything is saved. Deterministic and local-first:
 * no network, no AI, everything runs on the device.
 *
 * How it reads (in order):
 * 1. Quoted text (`"buy milk tomorrow"`) is a literal title - nothing
 *    inside quotes is ever parsed.
 * 2. Explicit dates: ISO (`2026-12-05`), month + day (`Dec 5`,
 *    `5 December`, optional year), and `12/5` - which is ambiguous
 *    (month-first vs day-first) and is never silently resolved.
 * 3. Times: `at 3pm`, `at 15:30`, `at noon`, `at midnight`. A bare
 *    hour (`at 5`, `at 9:30`) is ambiguous (AM vs PM) and is offered
 *    as a choice, not guessed.
 * 4. Relative dates: today, tomorrow, yesterday, tonight, next/this
 *    week, next month, this/next weekend, end of the week/month,
 *    `in 3 days`, `in two weeks`.
 * 5. Repeats: every day / daily, weekdays, every week / weekly, every
 *    month / monthly, every year, every N days/weeks/months, every
 *    other week, every Monday, every Mon Wed Fri, on Mondays, weekends.
 * 6. Bare weekdays: `Friday` is the next Friday on or after today;
 *    `next Friday` is the Friday of next week.
 * 7. `+Project` and `#tag` match the user's projects and tags;
 *    `!p1`..`!p4`, `!high`, `!medium`, `!low`, `!urgent` and
 *    `high priority` set a priority.
 * 8. A fuzzy pass (see `./fuzzy.ts`, ported from Print Handy) matches
 *    typo'd date and repeat words - `tommorow`, `wensday`, `every wek`
 *    - as suggestions, never as silent corrections. A clear
 *    high-confidence match with a margin over the runner-up is the
 *    single offered answer, flagged with the word it came from;
 *    anything grey-zone or contested is a pick-list; below the floor
 *    is not a match at all.
 *
 * Ambiguous input is never silently resolved: it stays in the title
 * (or out of the draft) and appears in the preview as a choice.
 * Unrecognized text always stays in the title. All dates are local
 * calendar dates - the parser only ever does calendar arithmetic
 * (`setDate`, noon-anchored keys), never "now + 24h", so daylight
 * saving transitions cannot shift a date.
 *
 * The task model has no time or priority field, so a parsed time or
 * priority is shown in the preview and saved as a visible note line
 * (`At 3:00 PM`, `Priority: High`) the user can drop before saving.
 */
import {
  addDays,
  parseKey,
  presetDate,
  repeatLabel,
  startOfWeek,
  toKey,
  todayKey,
  upcomingWeekend,
  type Repeat,
} from "./model.ts";
import {
  FUZZY_FLOOR,
  canonical,
  decide,
  fuzzyScore,
  norm,
  parseNumberPhrase,
  tokenMatch,
  windowedFuzzyScore,
  type Decision,
} from "./fuzzy.ts";

export type Priority = "high" | "medium" | "low" | "urgent";

export type SuggestionApply =
  | { field: "date"; date: string }
  | { field: "time"; time: string }
  | { field: "repeat"; repeat: Repeat }
  | { field: "projectId"; projectId: string }
  | { field: "categoryId"; categoryId: string }
  | { field: "priority"; priority: Priority };

export type SuggestionOption = {
  label: string;
  apply: SuggestionApply;
};

export type Suggestion = {
  kind: "date" | "time" | "repeat" | "project" | "tag" | "priority";
  /** Human-readable, e.g. "Tomorrow, Nov 23" or "Every week". */
  label: string;
  /** The raw word(s) this came from, e.g. "tommorow". */
  source: string;
  score: number;
  decision: "direct" | "suggest";
  /** The single clear answer (direct only). */
  apply: SuggestionApply | null;
  /** Pick-list (suggest only). */
  options: SuggestionOption[] | null;
};

export type Ambiguity = {
  /** The raw text that is ambiguous, e.g. "12/5" or "at 5". */
  text: string;
  readings: SuggestionOption[];
};

export type ParsedTask = {
  /** Unconsumed text: everything the parser did not understand stays here. */
  title: string;
  /** Local YYYY-MM-DD, or null when no date was parsed. */
  date: string | null;
  /** 24-hour "HH:MM", or null when no time was parsed. */
  time: string | null;
  repeat: Repeat;
  projectId: string | null;
  categoryId: string | null;
  priority: Priority | null;
  /** Fuzzy suggestions: applied (direct) or offered (suggest). */
  suggestions: Suggestion[];
  /** Ambiguous input offered as a choice, never silently resolved. */
  ambiguities: Ambiguity[];
  /** Raw spans the parser consumed, for tests and debugging. */
  consumed: string[];
};

export type ParseContext = {
  now?: Date;
  projects?: { id: string; name: string }[];
  categories?: { id: string; name: string }[];
};

export const WEEKDAY_WORDS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export const MONTH_WORDS = [
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
] as const;

/** Words with a complete date meaning on their own. */
export const DATE_WORDS = ["today", "tomorrow", "yesterday", "tonight", ...WEEKDAY_WORDS] as const;
/** Words with a complete repeat meaning on their own. */
export const REPEAT_WORDS = [
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "weekdays",
  "everyday",
] as const;
export const PRIORITY_WORDS = ["urgent", "high", "medium", "low"] as const;

const WEEKDAY_INDEX: Record<string, number> = {
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
  sunday: 0,
  sun: 0,
};

const MONTH_INDEX: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export function formatTimeLabel(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const hour = h ?? 0;
  const minute = m ?? 0;
  const suffix = hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/** The note lines a parsed time / priority save as (visible in the preview). */
export function parsedNoteLines(parsed: ParsedTask): string[] {
  const lines: string[] = [];
  if (parsed.priority) lines.push(`Priority: ${PRIORITY_LABEL[parsed.priority]}`);
  if (parsed.time) lines.push(`At ${formatTimeLabel(parsed.time)}`);
  return lines;
}

/** Stable signature of a parse, so the composer can reset preview edits when the text changes what it means. */
export function parseSignature(parsed: ParsedTask): string {
  return JSON.stringify([
    parsed.title,
    parsed.date,
    parsed.time,
    parsed.repeat,
    parsed.projectId,
    parsed.categoryId,
    parsed.priority,
    parsed.suggestions.map((s) => `${s.kind}:${s.label}:${s.decision}`),
    parsed.ambiguities.map((a) => a.text),
  ]);
}

type Word = {
  raw: string;
  folded: string;
  start: number;
  end: number;
  quoted: boolean;
  consumed: boolean;
};

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function addMonths(key: string, n: number): string {
  const start = parseKey(key);
  const target = new Date(start.getFullYear(), start.getMonth() + n, 1, 12);
  target.setDate(Math.min(start.getDate(), daysInMonth(target.getFullYear(), target.getMonth())));
  return toKey(target);
}

/** Next occurrence of weekday `day` (0 = Sunday) on or after `today`. */
function nextWeekday(today: string, day: number): string {
  const delta = (day - parseKey(today).getDay() + 7) % 7;
  return addDays(today, delta);
}

function validKey(key: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  return toKey(parseKey(key)) === key;
}

function monthDayKey(year: number, month: number, day: number): string | null {
  if (day < 1 || day > daysInMonth(year, month)) return null;
  const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return validKey(key) ? key : null;
}

export function parseNaturalLanguage(input: string, context: ParseContext = {}): ParsedTask {
  const now = context.now ?? new Date();
  const today = todayKey(now);
  const projects = context.projects ?? [];
  const categories = context.categories ?? [];

  const result: ParsedTask = {
    title: "",
    date: null,
    time: null,
    repeat: { kind: "none" },
    projectId: null,
    categoryId: null,
    priority: null,
    suggestions: [],
    ambiguities: [],
    consumed: [],
  };

  // Quoted spans are literal titles: replace each `"..."` with one
  // placeholder token that can never match a pattern, and restore the
  // inner text (quotes stripped) when the title is assembled.
  const quotedText = new Map<string, string>();
  let working = input;
  let quoteIndex = 0;
  working = working.replace(/"([^"]*)"/g, (_match, inner: string) => {
    const placeholder = `quoted${quoteIndex}`;
    quotedText.set(placeholder, inner);
    quoteIndex += 1;
    return placeholder;
  });

  const words: Word[] = [];
  for (const match of working.matchAll(/\S+/g)) {
    const raw = match[0] ?? "";
    const start = match.index ?? 0;
    words.push({
      raw,
      folded: norm(raw),
      start,
      end: start + raw.length,
      quoted: quotedText.has(raw),
      consumed: false,
    });
  }

  const consume = (at: number[]): void => {
    for (const i of at) {
      const word = words[i];
      if (word && !word.consumed) {
        word.consumed = true;
        result.consumed.push(word.raw);
      }
    }
  };
  const isFree = (i: number): boolean => {
    const word = words[i];
    return !!word && !word.consumed && !word.quoted;
  };
  const wordAt = (i: number): string => words[i]?.folded ?? "";

  /** Consume every word overlapped by a regex match over the working text. */
  const consumeSpan = (start: number, end: number): number[] => {
    const hit: number[] = [];
    words.forEach((word, i) => {
      if (!word.consumed && !word.quoted && word.start < end && word.end > start) hit.push(i);
    });
    if (hit.length === 0) return [];
    consume(hit);
    return hit;
  };

  const setDate = (date: string | null, _raw?: string): boolean => {
    if (result.date !== null || date === null) return false;
    result.date = date;
    return true;
  };

  // ---------------------------------------------------------- regex dates

  type RegexHit = { start: number; end: number; apply: () => void; ambiguous?: Ambiguity };
  const regexHits: RegexHit[] = [];
  const pushDateHit = (start: number, end: number, date: string | null, raw: string): void => {
    if (date === null) return;
    regexHits.push({
      start,
      end,
      apply: () => {
        if (setDate(date, raw)) consumeSpan(start, end);
      },
    });
  };

  for (const match of working.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const key = `${match[1]}-${match[2]}-${match[3]}`;
    if (validKey(key)) {
      pushDateHit(match.index ?? 0, (match.index ?? 0) + match[0].length, key, match[0]);
    }
  }

  const monthName = Object.keys(MONTH_INDEX).join("|");
  // "Dec 5", "December 5, 2026", "Dec 5th".
  for (const match of working.matchAll(
    new RegExp(`\\b(${monthName})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,\\s*(\\d{4}))?\\b`, "gi"),
  )) {
    const month = MONTH_INDEX[(match[1] ?? "").toLowerCase()];
    const day = Number.parseInt(match[2] ?? "0", 10);
    if (month === undefined || !day) continue;
    const year = match[3] ? Number.parseInt(match[3], 10) : now.getFullYear();
    let key = monthDayKey(year, month, day);
    // A month + day with no year that already passed rolls to next year.
    if (key && !match[3] && key < today) key = monthDayKey(year + 1, month, day);
    pushDateHit(match.index ?? 0, (match.index ?? 0) + match[0].length, key, match[0]);
  }
  // "5 December", "5th of December 2026".
  for (const match of working.matchAll(
    new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthName})(?:\\s*,?\\s*(\\d{4}))?\\b`,
      "gi",
    ),
  )) {
    const day = Number.parseInt(match[1] ?? "0", 10);
    const month = MONTH_INDEX[(match[2] ?? "").toLowerCase()];
    if (month === undefined || !day) continue;
    const year = match[3] ? Number.parseInt(match[3], 10) : now.getFullYear();
    let key = monthDayKey(year, month, day);
    if (key && !match[3] && key < today) key = monthDayKey(year + 1, month, day);
    pushDateHit(match.index ?? 0, (match.index ?? 0) + match[0].length, key, match[0]);
  }
  // "12/5" or "12/5/2026": ambiguous when both numbers could be a
  // month (<= 12) - offered as a choice, never silently resolved.
  for (const match of working.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
    const a = Number.parseInt(match[1] ?? "0", 10);
    const b = Number.parseInt(match[2] ?? "0", 10);
    const year = match[3]
      ? Number.parseInt(match[3], 10) + (match[3].length === 2 ? 2000 : 0)
      : now.getFullYear();
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const monthFirst = a >= 1 && a <= 12 && monthDayKey(year, a - 1, b);
    const dayFirst = b >= 1 && b <= 12 && monthDayKey(year, b - 1, a);
    if (monthFirst && dayFirst && monthFirst !== dayFirst) {
      result.ambiguities.push({
        text: match[0],
        readings: [
          { label: monthFirst, apply: { field: "date", date: monthFirst } },
          { label: dayFirst, apply: { field: "date", date: dayFirst } },
        ],
      });
    } else if (monthFirst) {
      pushDateHit(start, end, monthFirst, match[0]);
    } else if (dayFirst) {
      pushDateHit(start, end, dayFirst, match[0]);
    }
    // Neither reading is a real date: leave the text in the title.
  }

  // ---------------------------------------------------------- regex times

  const to24 = (hour: number, minute: number, meridiem: string | null): string | null => {
    if (minute < 0 || minute > 59) return null;
    if (meridiem) {
      if (hour < 1 || hour > 12) return null;
      const h = meridiem === "pm" ? (hour === 12 ? 12 : hour + 12) : hour === 12 ? 0 : hour;
      return `${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
    if (hour < 0 || hour > 23) return null;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  };

  for (const match of working.matchAll(/\bat\s+noon\b/gi)) {
    const start = match.index ?? 0;
    regexHits.push({
      start,
      end: start + match[0].length,
      apply: () => {
        if (result.time === null) {
          result.time = "12:00";
          consumeSpan(start, start + match[0].length);
        }
      },
    });
  }
  for (const match of working.matchAll(/\bat\s+midnight\b/gi)) {
    const start = match.index ?? 0;
    regexHits.push({
      start,
      end: start + match[0].length,
      apply: () => {
        if (result.time === null) {
          result.time = "00:00";
          consumeSpan(start, start + match[0].length);
        }
      },
    });
  }
  // "at 3:30pm", "at 3pm", "3:30 pm", "3pm".
  for (const match of working.matchAll(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi)) {
    const hour = Number.parseInt(match[1] ?? "0", 10);
    const minute = Number.parseInt(match[2] ?? "0", 10);
    const time = to24(hour, minute, (match[3] ?? "pm").toLowerCase());
    if (!time) continue;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    regexHits.push({
      start,
      end,
      apply: () => {
        if (result.time === null) {
          result.time = time;
          consumeSpan(start, end);
        }
      },
    });
  }
  // 24-hour colon times: "at 15:30", "15:30".
  for (const match of working.matchAll(/\b(?:at\s+)?(\d{1,2}):(\d{2})\b/g)) {
    const hour = Number.parseInt(match[1] ?? "0", 10);
    const minute = Number.parseInt(match[2] ?? "0", 10);
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (hour > 12) {
      const time = to24(hour, minute, null);
      if (!time) continue;
      regexHits.push({
        start,
        end,
        apply: () => {
          if (result.time === null) {
            result.time = time;
            consumeSpan(start, end);
          }
        },
      });
    } else {
      // "at 9:30" with no AM/PM is ambiguous - offer both readings.
      const am = to24(hour, minute, "am");
      const pm = to24(hour, minute, "pm");
      if (!am || !pm) continue;
      regexHits.push({
        start,
        end,
        ambiguous: {
          text: match[0],
          readings: [
            { label: formatTimeLabel(am), apply: { field: "time", time: am } },
            { label: formatTimeLabel(pm), apply: { field: "time", time: pm } },
          ],
        },
        apply: () => undefined,
      });
    }
  }
  // Bare hour with no AM/PM: "at 5" is ambiguous, never guessed.
  for (const match of working.matchAll(/\bat\s+(\d{1,2})\b/g)) {
    const hour = Number.parseInt(match[1] ?? "0", 10);
    if (hour < 1 || hour > 12) continue;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const am = to24(hour, 0, "am");
    const pm = to24(hour, 0, "pm");
    if (!am || !pm) continue;
    regexHits.push({
      start,
      end,
      ambiguous: {
        text: match[0],
        readings: [
          { label: formatTimeLabel(am), apply: { field: "time", time: am } },
          { label: formatTimeLabel(pm), apply: { field: "time", time: pm } },
        ],
      },
      apply: () => undefined,
    });
  }

  // Apply regex hits in text order, skipping overlaps. Ambiguous hits
  // record their choice and consume nothing.
  regexHits.sort((a, b) => a.start - b.start);
  const usedRanges: [number, number][] = [];
  for (const hit of regexHits) {
    if (usedRanges.some(([s, e]) => hit.start < e && hit.end > s)) continue;
    if (hit.ambiguous) {
      result.ambiguities.push(hit.ambiguous);
      usedRanges.push([hit.start, hit.end]);
      continue;
    }
    const before = result.consumed.length;
    hit.apply();
    if (result.consumed.length > before) usedRanges.push([hit.start, hit.end]);
  }

  // ------------------------------------------------- word-sequence passes

  const readCount = (i: number): [number, number] | null => {
    // Digits, "a"/"an" (= 1), or number words ("three", "twenty one").
    const word = wordAt(i);
    if (/^\d+$/.test(word)) return [Number.parseInt(word, 10), i + 1];
    if (word === "a" || word === "an") return [1, i + 1];
    const phrase = parseNumberPhrase(
      words.map((w) => w.folded),
      i,
    );
    return phrase;
  };
  const unitOf = (word: string): "day" | "week" | "month" | "year" | null => {
    if (word === "day" || word === "days") return "day";
    if (word === "week" || word === "weeks") return "week";
    if (word === "month" || word === "months") return "month";
    if (word === "year" || word === "years") return "year";
    return null;
  };

  // Relative dates.
  for (let i = 0; i < words.length; i++) {
    if (!isFree(i)) continue;
    const word = wordAt(i);
    if (word === "today" || word === "tonight") {
      if (setDate(today, word)) consume([i]);
      continue;
    }
    if (word === "tomorrow" || word === "tmrw" || word === "tmr") {
      if (setDate(addDays(today, 1), word)) consume([i]);
      continue;
    }
    if (word === "yesterday" || word === "yday") {
      if (setDate(addDays(today, -1), word)) consume([i]);
      continue;
    }
    if (word === "next" && isFree(i + 1)) {
      const next = wordAt(i + 1);
      if (next === "week") {
        if (setDate(presetDate("next-week", today), "next week")) consume([i, i + 1]);
        continue;
      }
      if (next === "month") {
        if (setDate(presetDate("next-month", today), "next month")) consume([i, i + 1]);
        continue;
      }
      if (next === "weekend") {
        if (setDate(addDays(upcomingWeekend(today), 7), "next weekend")) consume([i, i + 1]);
        continue;
      }
      if (next === "year") {
        if (setDate(addMonths(today, 12), "next year")) consume([i, i + 1]);
        continue;
      }
    }
    if (word === "this" && isFree(i + 1)) {
      const next = wordAt(i + 1);
      if (next === "week") {
        if (setDate(presetDate("this-week", today), "this week")) consume([i, i + 1]);
        continue;
      }
      if (next === "weekend") {
        if (setDate(upcomingWeekend(today), "this weekend")) consume([i, i + 1]);
        continue;
      }
      if (next === "month") {
        const last = new Date(now.getFullYear(), now.getMonth() + 1, 0, 12);
        if (setDate(toKey(last), "this month")) consume([i, i + 1]);
        continue;
      }
    }
    if (word === "end" && isFree(i + 1) && wordAt(i + 1) === "of") {
      let j = i + 2;
      if (wordAt(j) === "the") j += 1;
      if (isFree(j) && wordAt(j) === "week") {
        if (setDate(addDays(startOfWeek(today), 6), "end of the week")) {
          consume([i, i + 1, ...(wordAt(i + 2) === "the" ? [i + 2] : []), j]);
        }
        continue;
      }
      if (isFree(j) && wordAt(j) === "month") {
        const last = new Date(now.getFullYear(), now.getMonth() + 1, 0, 12);
        if (setDate(toKey(last), "end of the month")) {
          consume([i, i + 1, ...(wordAt(i + 2) === "the" ? [i + 2] : []), j]);
        }
        continue;
      }
    }
    if (word === "in" && isFree(i + 1)) {
      const count = readCount(i + 1);
      if (count) {
        const [n, after] = count;
        const unit = unitOf(wordAt(after));
        if (unit && n >= 1 && n <= 999) {
          const date =
            unit === "day"
              ? addDays(today, n)
              : unit === "week"
                ? addDays(today, n * 7)
                : unit === "month"
                  ? addMonths(today, n)
                  : addMonths(today, n * 12);
          if (setDate(date, `in ${n} ${unit}s`)) {
            consume(Array.from({ length: after + 1 - i }, (_, k) => i + k));
          }
        }
      }
    }
  }

  // Repeats.
  const setRepeat = (repeat: Repeat, at: number[]): boolean => {
    if (result.repeat.kind !== "none") return false;
    result.repeat = repeat;
    consume(at);
    return true;
  };
  for (let i = 0; i < words.length; i++) {
    if (!isFree(i)) continue;
    const word = wordAt(i);
    if (word === "daily" || word === "everyday") {
      if (setRepeat({ kind: "daily" }, [i])) continue;
    }
    if (word === "weekdays" || word === "weekday") {
      if (setRepeat({ kind: "weekdays" }, [i])) continue;
    }
    if (word === "weekly") {
      if (setRepeat({ kind: "weekly" }, [i])) continue;
    }
    if (word === "monthly") {
      if (setRepeat({ kind: "monthly" }, [i])) continue;
    }
    if (word === "yearly" || word === "annually") {
      if (setRepeat({ kind: "interval", every: 12, unit: "month" }, [i])) continue;
    }
    if (word === "weekends" || word === "weekend") {
      // A bare "weekend" was already handled as a date above; only a
      // plural "weekends" reads as a repeat here.
      if (word === "weekends" && setRepeat({ kind: "days", days: [0, 6] }, [i])) continue;
      continue;
    }
    if (word === "every" && isFree(i + 1)) {
      const next = wordAt(i + 1);
      if (next === "day") {
        if (setRepeat({ kind: "daily" }, [i, i + 1])) continue;
      }
      if (next === "week") {
        if (setRepeat({ kind: "weekly" }, [i, i + 1])) continue;
      }
      if (next === "month") {
        if (setRepeat({ kind: "monthly" }, [i, i + 1])) continue;
      }
      if (next === "year") {
        if (setRepeat({ kind: "interval", every: 12, unit: "month" }, [i, i + 1])) continue;
      }
      if (next === "weekday" || next === "weekdays") {
        if (setRepeat({ kind: "weekdays" }, [i, i + 1])) continue;
      }
      if (next === "weekend" || next === "weekends") {
        if (setRepeat({ kind: "days", days: [0, 6] }, [i, i + 1])) continue;
      }
      if (next === "other" && isFree(i + 2)) {
        const unit = unitOf(wordAt(i + 2));
        if (unit) {
          const repeat: Repeat =
            unit === "day"
              ? { kind: "interval", every: 2, unit: "day" }
              : unit === "week"
                ? { kind: "interval", every: 2, unit: "week" }
                : { kind: "interval", every: 2, unit: "month" };
          if (setRepeat(repeat, [i, i + 1, i + 2])) continue;
        }
      }
      // "every 2 weeks", "every second Tuesday", "every three days".
      const count = readCount(i + 1);
      if (count) {
        const [n, after] = count;
        const unit = unitOf(wordAt(after));
        if (unit && n >= 1 && n <= 99) {
          const repeat: Repeat =
            unit === "day"
              ? n === 1
                ? { kind: "daily" }
                : { kind: "interval", every: n, unit: "day" }
              : unit === "week"
                ? n === 1
                  ? { kind: "weekly" }
                  : { kind: "interval", every: n, unit: "week" }
                : unit === "month"
                  ? n === 1
                    ? { kind: "monthly" }
                    : { kind: "interval", every: n, unit: "month" }
                  : { kind: "interval", every: n * 12, unit: "month" };
          if (
            setRepeat(
              repeat,
              Array.from({ length: after + 1 - i }, (_, k) => i + k),
            )
          )
            continue;
        }
      }
      // "every Monday", "every Mon Wed Fri".
      const days: number[] = [];
      let j = i + 1;
      const used: number[] = [i];
      while (j < words.length && isFree(j)) {
        const w = wordAt(j);
        if (w === "and") {
          j += 1;
          continue;
        }
        const day = WEEKDAY_INDEX[w];
        if (day === undefined) break;
        days.push(day);
        used.push(j);
        j += 1;
      }
      if (days.length > 0) {
        const repeat: Repeat =
          days.length === 1 ? { kind: "days", days } : { kind: "days", days: [...new Set(days)] };
        if (setRepeat(repeat, used)) {
          if (result.date === null) result.date = nextWeekday(today, days[0] ?? 1);
          continue;
        }
      }
    }
    // "on Mondays", "on Mondays and Wednesdays".
    if (word === "on" && isFree(i + 1)) {
      const days: number[] = [];
      let j = i + 1;
      const used: number[] = [i];
      while (j < words.length && isFree(j)) {
        const w = wordAt(j);
        if (w === "and") {
          j += 1;
          continue;
        }
        const singular = w.endsWith("s") ? w.slice(0, -1) : w;
        const day = WEEKDAY_INDEX[singular] ?? WEEKDAY_INDEX[w];
        if (day === undefined) break;
        // Only plurals ("Mondays") read as a repeat; a singular here
        // is a date and is handled by the weekday pass below.
        if (w !== singular && w.endsWith("s")) {
          days.push(day);
          used.push(j);
          j += 1;
        } else {
          break;
        }
      }
      if (days.length > 0) {
        if (setRepeat({ kind: "days", days: [...new Set(days)] }, used)) {
          if (result.date === null) result.date = nextWeekday(today, days[0] ?? 1);
          continue;
        }
      }
    }
  }

  // Bare weekdays: "Friday" is the next Friday on or after today;
  // "next Friday" is the Friday of next week; "on Friday" is a date.
  for (let i = 0; i < words.length; i++) {
    if (!isFree(i)) continue;
    const word = wordAt(i);
    if (word === "next" && isFree(i + 1)) {
      const day = WEEKDAY_INDEX[wordAt(i + 1)];
      if (day !== undefined) {
        if (setDate(addDays(nextWeekday(today, day), 7), "next weekday")) consume([i, i + 1]);
        continue;
      }
    }
    if (word === "on" && isFree(i + 1)) {
      const day = WEEKDAY_INDEX[wordAt(i + 1)];
      if (day !== undefined) {
        if (setDate(nextWeekday(today, day), "on weekday")) consume([i, i + 1]);
        continue;
      }
    }
    const day = WEEKDAY_INDEX[word];
    if (day !== undefined) {
      if (setDate(nextWeekday(today, day), word)) consume([i]);
    }
  }

  // -------------------------------------------------- projects, tags, priority

  const matchNamed = (
    at: number,
    prefix: "+" | "#",
    pool: { id: string; name: string }[],
  ): { id: string; used: number[] } | null => {
    const first = words[at]?.raw ?? "";
    if (!first.startsWith(prefix)) return null;
    const head = first.slice(1);
    if (!head) return null;
    // Try the longest run of following words first: "Home Renovation".
    for (let len = Math.min(3, words.length - at); len >= 1; len--) {
      const parts = [head, ...words.slice(at + 1, at + len).map((w) => w.raw)];
      const candidate = parts.join(" ");
      const exact = pool.find((item) => norm(item.name) === norm(candidate));
      if (exact) {
        return { id: exact.id, used: Array.from({ length: len }, (_, k) => at + k) };
      }
    }
    return null;
  };

  const fuzzyNamed = (
    at: number,
    prefix: "+" | "#",
    pool: { id: string; name: string }[],
  ): {
    id: string;
    used: number[];
    score: number;
    decision: Decision<{ id: string; used: number[] }>;
    source: string;
  } | null => {
    const first = words[at]?.raw ?? "";
    if (!first.startsWith(prefix)) return null;
    const head = first.slice(1);
    if (!head) return null;
    const scored: [number, { id: string; used: number[] }][] = [];
    for (let len = 1; len <= Math.min(3, words.length - at); len++) {
      const parts = [head, ...words.slice(at + 1, at + len).map((w) => w.raw)];
      const candidate = parts.join(" ");
      for (const item of pool) {
        const score = Math.max(
          fuzzyScore(candidate, item.name),
          windowedFuzzyScore(candidate, item.name),
        );
        if (score >= FUZZY_FLOOR) {
          scored.push([
            score,
            { id: item.id, used: Array.from({ length: len }, (_, k) => at + k) },
          ]);
        }
      }
    }
    // One entry per project: a windowed hit on a shorter span and a
    // whole-string hit on a longer span are the same project, not two
    // contenders - without this, decide() sees a false conflict.
    const byId = new Map<string, [number, { id: string; used: number[] }]>();
    for (const entry of scored) {
      const prev = byId.get(entry[1].id);
      if (
        !prev ||
        entry[0] > prev[0] ||
        (entry[0] === prev[0] && entry[1].used.length > prev[1].used.length)
      ) {
        byId.set(entry[1].id, entry);
      }
    }
    const deduped = [...byId.values()];
    if (deduped.length === 0) return null;
    const decision = decide(deduped);
    if (decision.kind === "none" || !decision.best) return null;
    return {
      ...decision.best,
      score: deduped.find(([, p]) => p === decision.best)?.[0] ?? 0,
      decision,
      source: first,
    };
  };

  for (let i = 0; i < words.length; i++) {
    if (!isFree(i)) continue;
    const raw = words[i]?.raw ?? "";
    if (raw.startsWith("+") && result.projectId === null && projects.length > 0) {
      const exact = matchNamed(i, "+", projects);
      if (exact) {
        result.projectId = exact.id;
        consume(exact.used);
        continue;
      }
      const fuzzy = fuzzyNamed(i, "+", projects);
      if (fuzzy && fuzzy.decision.kind === "direct") {
        result.projectId = fuzzy.id;
        consume(fuzzy.used);
        const name = projects.find((p) => p.id === fuzzy.id)?.name ?? "";
        result.suggestions.push({
          kind: "project",
          label: name,
          source: fuzzy.source,
          score: fuzzy.score,
          decision: "direct",
          apply: { field: "projectId", projectId: fuzzy.id },
          options: null,
        });
        continue;
      }
      if (fuzzy && fuzzy.decision.kind === "suggest") {
        result.suggestions.push({
          kind: "project",
          label: `Project like "${fuzzy.source.slice(1)}"`,
          source: fuzzy.source,
          score: fuzzy.score,
          decision: "suggest",
          apply: null,
          options: fuzzy.decision.contenders.map((c) => ({
            label: projects.find((p) => p.id === c.id)?.name ?? "",
            apply: { field: "projectId", projectId: c.id },
          })),
        });
        continue;
      }
    }
    if (raw.startsWith("#") && result.categoryId === null && categories.length > 0) {
      const exact = matchNamed(i, "#", categories);
      if (exact) {
        result.categoryId = exact.id;
        consume(exact.used);
        continue;
      }
      const fuzzy = fuzzyNamed(i, "#", categories);
      if (fuzzy && fuzzy.decision.kind === "direct") {
        result.categoryId = fuzzy.id;
        consume(fuzzy.used);
        const name = categories.find((c) => c.id === fuzzy.id)?.name ?? "";
        result.suggestions.push({
          kind: "tag",
          label: name,
          source: fuzzy.source,
          score: fuzzy.score,
          decision: "direct",
          apply: { field: "categoryId", categoryId: fuzzy.id },
          options: null,
        });
        continue;
      }
      if (fuzzy && fuzzy.decision.kind === "suggest") {
        result.suggestions.push({
          kind: "tag",
          label: `Tag like "${fuzzy.source.slice(1)}"`,
          source: fuzzy.source,
          score: fuzzy.score,
          decision: "suggest",
          apply: null,
          options: fuzzy.decision.contenders.map((c) => ({
            label: categories.find((cat) => cat.id === c.id)?.name ?? "",
            apply: { field: "categoryId", categoryId: c.id },
          })),
        });
        continue;
      }
    }
    if (raw.startsWith("!") && result.priority === null) {
      const stem = norm(raw.slice(1));
      const byToken: Record<string, Priority> = {
        p1: "urgent",
        "1": "urgent",
        urgent: "urgent",
        p2: "high",
        "2": "high",
        high: "high",
        p3: "medium",
        "3": "medium",
        medium: "medium",
        p4: "low",
        "4": "low",
        low: "low",
      };
      const direct = byToken[stem];
      if (direct) {
        result.priority = direct;
        consume([i]);
        continue;
      }
      const [score, word] = tokenMatch(stem, PRIORITY_WORDS);
      if (word && score >= FUZZY_FLOOR) {
        const found = byToken[word];
        if (found) {
          result.priority = found;
          consume([i]);
          result.suggestions.push({
            kind: "priority",
            label: PRIORITY_LABEL[found],
            source: raw,
            score,
            decision: score >= 85 ? "direct" : "suggest",
            apply: { field: "priority", priority: found },
            options: null,
          });
        }
      }
      continue;
    }
  }

  // "high priority", "low priority", "medium priority".
  for (let i = 0; i < words.length; i++) {
    if (!isFree(i) || !isFree(i + 1)) continue;
    if (wordAt(i + 1) !== "priority" || result.priority !== null) continue;
    const found: Record<string, Priority> = {
      high: "high",
      low: "low",
      medium: "medium",
      urgent: "urgent",
    };
    const priority = found[wordAt(i)];
    if (priority) {
      result.priority = priority;
      consume([i, i + 1]);
    }
  }

  // ------------------------------------------------------------ fuzzy pass

  const meaningOfDateWord = (word: string): { date: string; label: string } | null => {
    if (word === "today" || word === "tonight") return { date: today, label: "Today" };
    if (word === "tomorrow") return { date: addDays(today, 1), label: "Tomorrow" };
    if (word === "yesterday") return { date: addDays(today, -1), label: "Yesterday" };
    const day = WEEKDAY_INDEX[word];
    if (day !== undefined) {
      const date = nextWeekday(today, day);
      const name = WEEKDAY_WORDS[day === 0 ? 6 : day - 1] ?? word;
      return { date, label: name.charAt(0).toUpperCase() + name.slice(1) };
    }
    return null;
  };
  const meaningOfRepeatWord = (word: string): { repeat: Repeat; label: string } | null => {
    if (word === "daily" || word === "everyday")
      return { repeat: { kind: "daily" }, label: "Every day" };
    if (word === "weekly") return { repeat: { kind: "weekly" }, label: "Every week" };
    if (word === "monthly") return { repeat: { kind: "monthly" }, label: "Every month" };
    if (word === "yearly")
      return { repeat: { kind: "interval", every: 12, unit: "month" }, label: "Every year" };
    if (word === "weekdays") return { repeat: { kind: "weekdays" }, label: "Weekdays" };
    return null;
  };

  for (let i = 0; i < words.length; i++) {
    if (!isFree(i)) continue;
    const word = words[i]?.folded ?? "";
    if (!word) continue;
    const raw = words[i]?.raw ?? "";
    // A raw word that folds to several tokens ("tomorrow's" ->
    // "tomorrow s") never fuzzy-matches: its meaning is not the bare
    // keyword it contains.
    if (word.includes(" ")) continue;

    // "every <typo'd unit>" - "every wek", "every mounth".
    if (word === "every" && isFree(i + 1) && result.repeat.kind === "none") {
      const nextWord = wordAt(i + 1);
      const nextRaw = words[i + 1]?.raw ?? "";
      const scored: [number, string][] = [];
      for (const unit of ["day", "week", "month", "year"]) {
        const score = fuzzyScore(nextWord, unit);
        if (score >= FUZZY_FLOOR) scored.push([score, unit]);
      }
      if (scored.length > 0) {
        const decision = decide(scored);
        if (decision.kind !== "none" && decision.best) {
          const unit = decision.best;
          const repeat: Repeat =
            unit === "day"
              ? { kind: "daily" }
              : unit === "week"
                ? { kind: "weekly" }
                : unit === "month"
                  ? { kind: "monthly" }
                  : { kind: "interval", every: 12, unit: "month" };
          const label = repeatLabel(repeat);
          if (decision.kind === "direct") {
            result.repeat = repeat;
            consume([i, i + 1]);
            result.suggestions.push({
              kind: "repeat",
              label,
              source: `every ${nextRaw}`,
              score: scored.find(([, u]) => u === unit)?.[0] ?? 0,
              decision: "direct",
              apply: { field: "repeat", repeat },
              options: null,
            });
          } else {
            result.suggestions.push({
              kind: "repeat",
              label: `Repeat like "every ${nextRaw}"`,
              source: `every ${nextRaw}`,
              score: scored[0]?.[0] ?? 0,
              decision: "suggest",
              apply: null,
              options: decision.contenders.map((u) => {
                const r: Repeat =
                  u === "day"
                    ? { kind: "daily" }
                    : u === "week"
                      ? { kind: "weekly" }
                      : u === "month"
                        ? { kind: "monthly" }
                        : { kind: "interval", every: 12, unit: "month" };
                return { label: repeatLabel(r), apply: { field: "repeat", repeat: r } };
              }),
            });
          }
          continue;
        }
      }
    }

    // Single typo'd date / repeat words.
    const vocab = [
      ...DATE_WORDS.filter(
        (w) => result.date === null || !WEEKDAY_WORDS.includes(w as (typeof WEEKDAY_WORDS)[number]),
      ),
      ...REPEAT_WORDS.filter(() => result.repeat.kind === "none"),
    ];
    if (vocab.length === 0) continue;
    // Short words only match through the curated canonical table
    // (abbreviations and pinned typos), never through edit distance -
    // one typo in a short word is another word.
    const canon = canonical(word);
    const canonHit = vocab.find((v) => canonical(v) === canon && v !== word);
    if (canonHit && word.length < 4) {
      const dateMeaning = meaningOfDateWord(canonHit);
      const repeatMeaning = meaningOfRepeatWord(canonHit);
      if (dateMeaning && result.date === null) {
        result.date = dateMeaning.date;
        consume([i]);
        result.suggestions.push({
          kind: "date",
          label: dateMeaning.label,
          source: raw,
          score: 99,
          decision: "direct",
          apply: { field: "date", date: dateMeaning.date },
          options: null,
        });
      } else if (repeatMeaning && result.repeat.kind === "none") {
        result.repeat = repeatMeaning.repeat;
        consume([i]);
        result.suggestions.push({
          kind: "repeat",
          label: repeatMeaning.label,
          source: raw,
          score: 99,
          decision: "direct",
          apply: { field: "repeat", repeat: repeatMeaning.repeat },
          options: null,
        });
      }
      continue;
    }
    if (word.length < 4) continue;
    const scored: [number, string][] = [];
    for (const candidate of vocab) {
      const score = fuzzyScore(word, candidate);
      if (score >= FUZZY_FLOOR) scored.push([score, candidate]);
    }
    if (scored.length === 0) continue;
    const decision = decide(scored);
    if (decision.kind === "none" || !decision.best) continue;
    const best = decision.best;
    const bestScore = scored.find(([, v]) => v === best)?.[0] ?? 0;
    const dateMeaning = meaningOfDateWord(best);
    const repeatMeaning = meaningOfRepeatWord(best);
    const meaning = dateMeaning ?? repeatMeaning;
    if (!meaning) continue;
    const kind = dateMeaning ? "date" : "repeat";
    const label = dateMeaning ? dateMeaning.label : (repeatMeaning?.label ?? best);
    const apply: SuggestionApply = dateMeaning
      ? { field: "date", date: dateMeaning.date }
      : { field: "repeat", repeat: (repeatMeaning as { repeat: Repeat }).repeat };
    if (decision.kind === "direct") {
      // Only consume and record when the meaning actually lands: a
      // second date word when one is already set stays in the title.
      const appliedDate = dateMeaning !== null && result.date === null;
      const appliedRepeat = repeatMeaning !== null && result.repeat.kind === "none";
      if (!appliedDate && !appliedRepeat) continue;
      if (appliedDate && dateMeaning) result.date = dateMeaning.date;
      if (appliedRepeat && repeatMeaning) result.repeat = repeatMeaning.repeat;
      consume([i]);
      result.suggestions.push({
        kind,
        label,
        source: raw,
        score: bestScore,
        decision: "direct",
        apply,
        options: null,
      });
    } else {
      result.suggestions.push({
        kind,
        label: `Did you mean "${best}"?`,
        source: raw,
        score: bestScore,
        decision: "suggest",
        apply: null,
        options: decision.contenders.map((candidate) => {
          const d = meaningOfDateWord(candidate);
          const r = meaningOfRepeatWord(candidate);
          if (d) return { label: d.label, apply: { field: "date", date: d.date } };
          return {
            label: r?.label ?? candidate,
            apply: { field: "repeat", repeat: (r as { repeat: Repeat }).repeat },
          };
        }),
      });
    }
  }

  // ------------------------------------------------------------ title out

  result.title = words
    .filter((word) => !word.consumed)
    .map((word) => quotedText.get(word.raw) ?? word.raw)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return result;
}
