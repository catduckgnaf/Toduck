import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextOccurrence, type Repeat } from "./model.ts";
import { FUZZY_FLOOR } from "./fuzzy.ts";
import {
  DATE_WORDS,
  PRIORITY_WORDS,
  REPEAT_WORDS,
  formatTimeLabel,
  parseNaturalLanguage,
  parseSignature,
  parsedNoteLines,
  type ParsedTask,
} from "./natural-language.ts";

// Tuesday 2026-11-10, noon local. Weeks start on Monday.
const NOW = new Date(2026, 10, 10, 12, 0, 0);
const TUESDAY = "2026-11-10";

function parse(
  input: string,
  extra: {
    projects?: { id: string; name: string }[];
    categories?: { id: string; name: string }[];
  } = {},
): ParsedTask {
  return parseNaturalLanguage(input, { now: NOW, ...extra });
}

describe("common dates", () => {
  it("parses today, tomorrow and yesterday", () => {
    assert.equal(parse("Buy milk today").date, "2026-11-10");
    assert.equal(parse("Buy milk tomorrow").date, "2026-11-11");
    assert.equal(parse("Buy milk yesterday").date, "2026-11-09");
    assert.equal(parse("Buy milk tomorrow").title, "Buy milk");
  });

  it("parses bare weekdays as the next occurrence on or after today", () => {
    assert.equal(parse("Call mom Friday").date, "2026-11-13");
    assert.equal(parse("Call mom Tuesday").date, "2026-11-10");
    assert.equal(parse("Call mom Monday").date, "2026-11-16");
    assert.equal(parse("Call mom on Friday").date, "2026-11-13");
  });

  it("parses next weekday as the one in next week", () => {
    assert.equal(parse("Fix sink next Friday").date, "2026-11-20");
    assert.equal(parse("Fix sink next Tuesday").date, "2026-11-17");
  });

  it("parses month + day in both orders, rolling a past date to next year", () => {
    assert.equal(parse("Pay bill Dec 5").date, "2026-12-05");
    assert.equal(parse("Pay bill 5 December").date, "2026-12-05");
    assert.equal(parse("Pay bill December 5, 2026").date, "2026-12-05");
    assert.equal(parse("Pay bill Jan 5").date, "2027-01-05");
  });

  it("parses ISO dates and rejects impossible ones", () => {
    assert.equal(parse("Pay bill 2026-12-05").date, "2026-12-05");
    assert.equal(parse("Read Feb 30").date, null);
    assert.equal(parse("Read Feb 30").title, "Read Feb 30");
    assert.equal(parse("Read 2026-02-30").date, null);
  });

  it("parses in N days/weeks/months, digits and number words alike", () => {
    assert.equal(parse("Water plants in 3 days").date, "2026-11-13");
    assert.equal(parse("Water plants in two weeks").date, "2026-11-24");
    assert.equal(parse("Water plants in a month").date, "2026-12-10");
    assert.equal(parse("Water plants in twenty one days").date, "2026-12-01");
  });

  it("parses next week, this week and next month like the preset chips", () => {
    assert.equal(parse("Plan next week").date, "2026-11-22");
    assert.equal(parse("Plan this week").date, "2026-11-15");
    assert.equal(parse("Plan next month").date, "2026-12-10");
  });

  it("parses weekends and ends of week/month", () => {
    assert.equal(parse("Hike this weekend").date, "2026-11-14");
    assert.equal(parse("Hike next weekend").date, "2026-11-21");
    assert.equal(parse("Report end of the week").date, "2026-11-15");
    assert.equal(parse("Report end of the month").date, "2026-11-30");
  });
});

describe("times", () => {
  it("parses 12-hour, 24-hour, noon and midnight times", () => {
    assert.equal(parse("Call mom at 3pm").time, "15:00");
    assert.equal(parse("Call mom at 3:30pm").time, "15:30");
    assert.equal(parse("Call mom at 15:30").time, "15:30");
    assert.equal(parse("Call mom 9am").time, "09:00");
    assert.equal(parse("Call mom at noon").time, "12:00");
    assert.equal(parse("Call mom at midnight").time, "00:00");
    assert.equal(parse("Call mom at 12am").time, "00:00");
    assert.equal(parse("Call mom at 12pm").time, "12:00");
  });

  it("keeps the time with its date", () => {
    const parsed = parse("Call mom tomorrow at 3pm");
    assert.equal(parsed.date, "2026-11-11");
    assert.equal(parsed.time, "15:00");
    assert.equal(parsed.title, "Call mom");
  });

  it("rejects impossible times instead of guessing", () => {
    assert.equal(parse("Call mom at 25:00").time, null);
    assert.equal(parse("Call mom at 13pm").time, null);
    assert.equal(parse("Call mom at 3:60pm").time, null);
  });

  it("formats times for the preview and note lines", () => {
    assert.equal(formatTimeLabel("15:00"), "3:00 PM");
    assert.equal(formatTimeLabel("00:00"), "12:00 AM");
    assert.equal(formatTimeLabel("09:30"), "9:30 AM");
    assert.deepEqual(parsedNoteLines(parse("Call mom at 3pm")), ["At 3:00 PM"]);
  });
});

describe("repeats", () => {
  it("parses daily, weekly, monthly and yearly repeats", () => {
    assert.deepEqual(parse("Stretch daily").repeat, { kind: "daily" });
    assert.deepEqual(parse("Stretch every day").repeat, { kind: "daily" });
    assert.deepEqual(parse("Review weekly").repeat, { kind: "weekly" });
    assert.deepEqual(parse("Review every week").repeat, { kind: "weekly" });
    assert.deepEqual(parse("Pay rent monthly").repeat, { kind: "monthly" });
    assert.deepEqual(parse("Renew yearly").repeat, { kind: "interval", every: 12, unit: "month" });
    assert.deepEqual(parse("Standup weekdays").repeat, { kind: "weekdays" });
  });

  it("parses every N days/weeks/months and every other week", () => {
    assert.deepEqual(parse("Water every 2 days").repeat, {
      kind: "interval",
      every: 2,
      unit: "day",
    });
    assert.deepEqual(parse("Dentist every 2 weeks").repeat, {
      kind: "interval",
      every: 2,
      unit: "week",
    });
    assert.deepEqual(parse("Report every three months").repeat, {
      kind: "interval",
      every: 3,
      unit: "month",
    });
    assert.deepEqual(parse("Mow every other week").repeat, {
      kind: "interval",
      every: 2,
      unit: "week",
    });
  });

  it("parses every weekday and weekday lists, anchoring the date on the first day", () => {
    const monday = parse("Call mom every Monday");
    assert.deepEqual(monday.repeat, { kind: "days", days: [1] });
    assert.equal(monday.date, "2026-11-16");
    const list = parse("Gym every Mon Wed Fri");
    assert.deepEqual(list.repeat, { kind: "days", days: [1, 3, 5] });
    assert.equal(list.date, "2026-11-16");
    const plural = parse("Meeting on Fridays");
    assert.deepEqual(plural.repeat, { kind: "days", days: [5] });
    assert.equal(plural.date, "2026-11-13");
    assert.deepEqual(parse("Rest weekends").repeat, { kind: "days", days: [0, 6] });
  });

  it("combines a repeat with a date and a time", () => {
    const parsed = parse("Call mom every Monday at 3pm");
    assert.equal(parsed.date, "2026-11-16");
    assert.equal(parsed.time, "15:00");
    assert.deepEqual(parsed.repeat, { kind: "days", days: [1] });
  });
});

describe("recurrence", () => {
  it("advances a parsed weekly repeat through its occurrences", () => {
    const parsed = parse("Call mom every Monday");
    assert.equal(
      nextOccurrence(parsed.date ?? TUESDAY, parsed.repeat, parsed.date ?? TUESDAY),
      "2026-11-23",
    );
  });

  it("advances a parsed interval repeat from its anchor", () => {
    const parsed = parse("Dentist every 2 weeks");
    const anchor = parsed.date ?? TUESDAY;
    assert.equal(nextOccurrence(anchor, parsed.repeat, anchor), "2026-11-24");
  });

  it("clamps a monthly repeat at short months", () => {
    const repeat: Repeat = { kind: "monthly" };
    assert.equal(nextOccurrence("2026-01-31", repeat, "2026-01-31"), "2026-02-28");
    assert.equal(nextOccurrence("2026-02-28", repeat, "2026-02-28"), "2026-03-28");
  });
});

describe("date boundaries and daylight saving", () => {
  it("crosses month and year boundaries", () => {
    const newYearsEve = new Date(2026, 11, 31, 12, 0, 0);
    assert.equal(parseNaturalLanguage("Party tomorrow", { now: newYearsEve }).date, "2027-01-01");
    assert.equal(parseNaturalLanguage("Party in 2 days", { now: newYearsEve }).date, "2027-01-02");
    const jan31 = new Date(2026, 0, 31, 12, 0, 0);
    assert.equal(parseNaturalLanguage("Pay next month", { now: jan31 }).date, "2026-02-28");
  });

  it("lands on the right calendar date across the spring-forward transition", () => {
    // 2026-03-08 is the US spring-forward day: 2:00 AM jumps to 3:00 AM.
    const march7 = new Date(2026, 2, 7, 12, 0, 0);
    assert.equal(parseNaturalLanguage("Do thing tomorrow", { now: march7 }).date, "2026-03-08");
    assert.equal(parseNaturalLanguage("Do thing in 2 days", { now: march7 }).date, "2026-03-09");
    assert.equal(parseNaturalLanguage("Do thing in 3 days", { now: march7 }).date, "2026-03-10");
  });

  it("lands on the right calendar date across the fall-back transition", () => {
    // 2026-11-01 is the US fall-back day: 2:00 AM repeats as 1:00 AM.
    const oct31 = new Date(2026, 9, 31, 12, 0, 0);
    assert.equal(parseNaturalLanguage("Do thing tomorrow", { now: oct31 }).date, "2026-11-01");
    assert.equal(parseNaturalLanguage("Do thing in 2 days", { now: oct31 }).date, "2026-11-02");
    assert.equal(parseNaturalLanguage("Do thing next Sunday", { now: oct31 }).date, "2026-11-08");
  });

  it("accepts Feb 29 only in a leap year", () => {
    assert.equal(parse("Party Feb 29").date, null);
    assert.equal(parse("Party Feb 29").title, "Party Feb 29");
    const leap = new Date(2028, 1, 27, 12, 0, 0);
    assert.equal(parseNaturalLanguage("Party Feb 29", { now: leap }).date, "2028-02-29");
  });
});

describe("time zones", () => {
  it("reads today in local time, not UTC", () => {
    // 23:30 local on Nov 10 is 04:30 UTC on Nov 11 in US Eastern: a
    // UTC reader would call it Nov 11, the local reader Nov 10.
    const late = new Date(2026, 10, 10, 23, 30, 0);
    assert.equal(parseNaturalLanguage("Do thing today", { now: late }).date, "2026-11-10");
    assert.equal(parseNaturalLanguage("Do thing tomorrow", { now: late }).date, "2026-11-11");
  });

  it("reads an early-morning today in local time", () => {
    const early = new Date(2026, 10, 10, 0, 30, 0);
    assert.equal(parseNaturalLanguage("Do thing today", { now: early }).date, "2026-11-10");
  });
});

describe("ambiguous input", () => {
  it("offers both readings of a slash date and applies neither", () => {
    const parsed = parse("Buy milk 12/5");
    assert.equal(parsed.date, null);
    assert.equal(parsed.title, "Buy milk 12/5");
    assert.equal(parsed.ambiguities.length, 1);
    assert.deepEqual(
      parsed.ambiguities[0]?.readings.map((r) => r.label),
      ["2026-12-05", "2026-05-12"],
    );
  });

  it("resolves a slash date when only one reading is a real month", () => {
    assert.equal(parse("Buy milk 13/5").date, "2026-05-13");
    assert.equal(parse("Buy milk 5/13").date, "2026-05-13");
  });

  it("offers both readings of a bare hour and applies neither", () => {
    const parsed = parse("Call mom at 5");
    assert.equal(parsed.time, null);
    assert.equal(parsed.title, "Call mom at 5");
    assert.equal(parsed.ambiguities.length, 1);
    assert.deepEqual(
      parsed.ambiguities[0]?.readings.map((r) => r.label),
      ["5:00 AM", "5:00 PM"],
    );
  });

  it("offers both readings of a bare colon time", () => {
    const parsed = parse("Call mom at 9:30");
    assert.equal(parsed.time, null);
    assert.deepEqual(
      parsed.ambiguities[0]?.readings.map((r) => r.label),
      ["9:30 AM", "9:30 PM"],
    );
  });

  it("keeps the first date and leaves a second date word in the title", () => {
    const parsed = parse("Buy milk today tomorrow");
    assert.equal(parsed.date, "2026-11-10");
    assert.equal(parsed.title, "Buy milk tomorrow");
  });
});

describe("unrecognized text is preserved", () => {
  it("keeps words the parser does not understand in the title", () => {
    assert.equal(parse("Buy 12 giraffes").title, "Buy 12 giraffes");
    assert.equal(parse("Buy 12 giraffes").date, null);
    assert.equal(parse("Plan May party").title, "Plan May party");
    assert.equal(parse("Plan May party").date, null);
    assert.equal(parse("Call mom about the thing").title, "Call mom about the thing");
  });

  it("keeps an unknown +project token in the title", () => {
    const parsed = parse("Buy milk +Nowhere", {
      projects: [{ id: "p1", name: "Home" }],
    });
    assert.equal(parsed.projectId, null);
    assert.equal(parsed.title, "Buy milk +Nowhere");
  });

  it("keeps possessives from being read as date words", () => {
    assert.equal(parse("Plan tomorrow's meeting").date, null);
    assert.equal(parse("Plan tomorrow's meeting").title, "Plan tomorrow's meeting");
  });
});

describe("quoted titles", () => {
  it("never parses inside double quotes", () => {
    const parsed = parse('"Buy milk tomorrow" for real');
    assert.equal(parsed.date, null);
    assert.equal(parsed.title, "Buy milk tomorrow for real");
  });

  it("still parses outside the quotes", () => {
    const parsed = parse('"Buy milk" tomorrow');
    assert.equal(parsed.date, "2026-11-11");
    assert.equal(parsed.title, "Buy milk");
  });
});

describe("projects, tags and priorities", () => {
  const context = {
    projects: [{ id: "p1", name: "Home Renovation" }],
    categories: [
      { id: "c1", name: "Work" },
      { id: "c2", name: "Health" },
    ],
  };

  it("matches +Project and #tag exactly, including multi-word projects", () => {
    const parsed = parse("Buy milk +Home Renovation #Work", context);
    assert.equal(parsed.projectId, "p1");
    assert.equal(parsed.categoryId, "c1");
    assert.equal(parsed.title, "Buy milk");
  });

  it("matches a typo'd project as a flagged direct suggestion", () => {
    const parsed = parse("Buy milk +Home Renovatio", context);
    assert.equal(parsed.projectId, "p1");
    assert.equal(parsed.suggestions[0]?.kind, "project");
    assert.equal(parsed.suggestions[0]?.decision, "direct");
  });

  it("parses !p1..!p4, !high and high priority", () => {
    assert.equal(parse("Call mom !p1").priority, "urgent");
    assert.equal(parse("Call mom !high").priority, "high");
    assert.equal(parse("Call mom !p3").priority, "medium");
    assert.equal(parse("Call mom !low").priority, "low");
    assert.equal(parse("Call mom high priority").priority, "high");
    assert.equal(parse("Call mom low priority").priority, "low");
    assert.deepEqual(parsedNoteLines(parse("Call mom !urgent at 3pm")), [
      "Priority: Urgent",
      "At 3:00 PM",
    ]);
  });

  it("combines date, time, repeat, project, tag and priority in one line", () => {
    const parsed = parse("Buy milk tomorrow at 3pm +Home Renovation #Work !high", context);
    assert.equal(parsed.title, "Buy milk");
    assert.equal(parsed.date, "2026-11-11");
    assert.equal(parsed.time, "15:00");
    assert.equal(parsed.projectId, "p1");
    assert.equal(parsed.categoryId, "c1");
    assert.equal(parsed.priority, "high");
  });
});

describe("fuzzy suggestions", () => {
  it("matches a typo'd date word as a flagged direct suggestion", () => {
    const parsed = parse("Buy milk tommorow");
    assert.equal(parsed.date, "2026-11-11");
    assert.equal(parsed.title, "Buy milk");
    assert.equal(parsed.suggestions.length, 1);
    assert.equal(parsed.suggestions[0]?.kind, "date");
    assert.equal(parsed.suggestions[0]?.label, "Tomorrow");
    assert.equal(parsed.suggestions[0]?.source, "tommorow");
    assert.equal(parsed.suggestions[0]?.decision, "direct");
    assert.ok((parsed.suggestions[0]?.score ?? 0) >= FUZZY_FLOOR);
  });

  it("matches a typo'd weekday and a typo'd repeat unit", () => {
    const weekday = parse("Call mom wensday");
    assert.equal(weekday.date, "2026-11-11");
    assert.equal(weekday.suggestions[0]?.label, "Wednesday");
    const repeat = parse("Paint wall every wek");
    assert.deepEqual(repeat.repeat, { kind: "weekly" });
    assert.equal(repeat.suggestions[0]?.kind, "repeat");
    assert.equal(repeat.suggestions[0]?.decision, "direct");
  });

  it("offers a pick-list, and applies nothing, for a grey-zone typo", () => {
    // "tmrow" is three edits from "tomorrow" (past the typo limit), so
    // it lands in the suggest band at 77 rather than being corrected.
    const parsed = parse("Buy milk tmrow");
    assert.equal(parsed.date, null);
    assert.equal(parsed.title, "Buy milk tmrow");
    assert.equal(parsed.suggestions.length, 1);
    assert.equal(parsed.suggestions[0]?.decision, "suggest");
    assert.ok((parsed.suggestions[0]?.options?.length ?? 0) >= 1);
  });

  it("matches nothing below the floor", () => {
    const parsed = parse("Buy milk zzzqqq");
    assert.equal(parsed.date, null);
    assert.equal(parsed.title, "Buy milk zzzqqq");
    assert.deepEqual(parsed.suggestions, []);
  });

  it("never silently corrects a word that is also a title word", () => {
    // "weekly" spelled right is a repeat; "weakly" is not close enough
    // to act on without the user.
    const parsed = parse("Feel weakly today");
    assert.equal(parsed.date, "2026-11-10");
    assert.equal(parsed.title, "Feel weakly");
  });
});

describe("vocabulary coverage pin", () => {
  it("every date word parses exactly", () => {
    for (const word of DATE_WORDS) {
      const parsed = parse(`Do thing ${word}`);
      assert.notEqual(parsed.date, null, `date word "${word}" should parse`);
    }
  });

  it("every repeat word parses exactly", () => {
    for (const word of REPEAT_WORDS) {
      const parsed = parse(`Do thing ${word}`);
      assert.notEqual(parsed.repeat.kind, "none", `repeat word "${word}" should parse`);
    }
  });

  it("every priority word parses exactly with a ! prefix", () => {
    for (const word of PRIORITY_WORDS) {
      const parsed = parse(`Do thing !${word}`);
      assert.equal(parsed.priority, word, `priority word "${word}" should parse`);
    }
  });

  it("a one-letter typo of every date and repeat word still suggests it", () => {
    const typoOf = (word: string): string => {
      // Drop the second letter: "tomorrow" -> "tmorrow", "daily" -> "dily".
      return word.slice(0, 1) + word.slice(2);
    };
    for (const word of [...DATE_WORDS, ...REPEAT_WORDS]) {
      const typo = typoOf(word);
      if (typo === word || typo.length < 4) continue;
      const parsed = parse(`Do thing ${typo}`);
      assert.ok(
        parsed.suggestions.length > 0 || parsed.date !== null || parsed.repeat.kind !== "none",
        `typo "${typo}" of "${word}" should suggest or parse`,
      );
      for (const suggestion of parsed.suggestions) {
        assert.ok(suggestion.score >= FUZZY_FLOOR, `suggestion for "${typo}" is below the floor`);
      }
    }
  });
});

describe("parseSignature", () => {
  it("changes when the text changes what it means", () => {
    const a = parseSignature(parse("Buy milk tomorrow"));
    const b = parseSignature(parse("Buy milk Friday"));
    const c = parseSignature(parse("Buy milk tomorrow"));
    assert.notEqual(a, b);
    assert.equal(a, c);
  });
});
