import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FUZZY_FLOOR,
  HIGH_CONFIDENCE,
  canonical,
  correctToken,
  decide,
  editDistance,
  fuzzyScore,
  norm,
  sequenceMatcherRatio,
  tokenMatch,
  windowedFuzzyScore,
} from "./fuzzy.ts";

describe("norm", () => {
  it("folds case, diacritics and punctuation to one space-separated form", () => {
    assert.equal(norm("Café naïve résumé!"), "cafe naive resume");
    assert.equal(norm("  Every   Day  "), "every day");
    assert.equal(norm("3pm,"), "3pm");
  });

  it("keeps letters and digits of any script", () => {
    assert.equal(norm("Buy 2 tickets"), "buy 2 tickets");
  });
});

describe("canonical", () => {
  it("equates number words, ordinals and digits", () => {
    assert.equal(canonical("twenty first"), "21");
    assert.equal(canonical("twenty one"), "21");
    assert.equal(canonical("2nd"), "2");
    assert.equal(canonical("second"), "2");
  });

  it("equates abbreviations and joined/spaced spellings", () => {
    assert.equal(canonical("tmrw"), "tomorrow");
    assert.equal(canonical("everyday"), "every day");
    assert.equal(canonical("every day"), "every day");
  });

  it("folds plurals and verb forms", () => {
    assert.equal(canonical("weekdays"), "weekday");
    assert.equal(canonical("repeating"), "repeat");
  });
});

describe("sequenceMatcherRatio", () => {
  it("matches difflib's ratio on a transposition", () => {
    // 2 * 7 matching chars / 16 total chars.
    assert.equal(sequenceMatcherRatio("tomorrow", "tommorow"), 0.875);
  });

  it("is 1 for identical strings and 0 when one side is empty", () => {
    assert.equal(sequenceMatcherRatio("tomorrow", "tomorrow"), 1);
    assert.equal(sequenceMatcherRatio("", "tomorrow"), 0);
  });
});

describe("fuzzyScore", () => {
  it("never reaches 100: exact is a separate tier", () => {
    assert.equal(fuzzyScore("tomorrow", "tomorrow"), 99);
  });

  it("scores a typo'd date word in the high band", () => {
    assert.ok(fuzzyScore("tommorow", "tomorrow") >= HIGH_CONFIDENCE);
    assert.ok(fuzzyScore("wensday", "wednesday") >= HIGH_CONFIDENCE);
  });

  it("returns 0 below the floor", () => {
    assert.equal(fuzzyScore("xyzqq", "tomorrow"), 0);
    assert.equal(fuzzyScore("giraffe", "tomorrow"), 0);
  });

  it("rejects false friends through the token-coverage guard", () => {
    // One shared word must not carry three unrelated ones.
    assert.equal(fuzzyScore("weekly team meeting notes", "weekly"), 0);
    assert.equal(fuzzyScore("buy milk and eggs", "tomorrow"), 0);
  });

  it("rescues spelling-by-ear pairs through the phonetic pass", () => {
    assert.ok(fuzzyScore("enuf", "enough") >= FUZZY_FLOOR);
  });

  it("is symmetric enough for short keywords", () => {
    assert.ok(fuzzyScore("week", "wek") >= HIGH_CONFIDENCE);
  });
});

describe("windowedFuzzyScore", () => {
  it("finds a query inside a longer multi-word name", () => {
    assert.ok(
      windowedFuzzyScore("home renovation", "my home renovation project") >= HIGH_CONFIDENCE,
    );
    assert.ok(fuzzyScore("home renovation", "my home renovation project") < HIGH_CONFIDENCE);
  });
});

describe("tokenMatch", () => {
  it("finds a typo'd keyword without the rest of the sentence dragging it down", () => {
    const [score, word] = tokenMatch("call mom tommorow", ["tomorrow", "today", "monday"]);
    assert.ok(score >= HIGH_CONFIDENCE);
    assert.equal(word, "tomorrow");
  });

  it("matches short words exactly only, apart from pinned typo-table forms", () => {
    // "wke" is not a pinned form: one typo in a short word is another word.
    const [score, word] = tokenMatch("wke", ["week", "month"]);
    assert.equal(score, 0);
    assert.equal(word, null);
    // "wek" IS pinned (wek -> week), so canonical equivalence applies.
    const [pinnedScore, pinnedWord] = tokenMatch("wek", ["week", "month"]);
    assert.ok(pinnedScore >= HIGH_CONFIDENCE);
    assert.equal(pinnedWord, "week");
  });

  it("returns (0, null) when nothing reaches the floor", () => {
    assert.deepEqual(tokenMatch("giraffe", ["tomorrow", "today"]), [0, null]);
  });
});

describe("editDistance", () => {
  it("counts a transposition as one edit", () => {
    assert.equal(editDistance("thrusday", "thursday", 2), 1);
    assert.equal(editDistance("shrnik", "shrink", 2), 1);
  });

  it("counts a dropped letter plus a moved one as two edits", () => {
    assert.equal(editDistance("tommorow", "tomorrow", 2), 2);
  });

  it("stops past the limit", () => {
    assert.equal(editDistance("tomorrow", "giraffe", 2), 3);
  });
});

describe("correctToken", () => {
  it("corrects a bounded misspelling to the unique vocabulary word", () => {
    assert.equal(correctToken("tommorow", ["tomorrow", "today", "monday"]), "tomorrow");
  });

  it("leaves a tied token alone instead of guessing", () => {
    // "tursday" is one edit from both "tuesday" and "thursday": a
    // genuine ambiguity, so the token is left for the pick-list.
    assert.equal(correctToken("tursday", ["tuesday", "thursday", "today"]), "tursday");
  });

  it("leaves real words and numbers alone", () => {
    assert.equal(correctToken("tomorrow", ["tomorrow", "today"]), "tomorrow");
    assert.equal(correctToken("123", ["tomorrow"]), "123");
  });
});

describe("decide", () => {
  it("is direct only at high confidence with a clear margin", () => {
    assert.deepEqual(
      decide([
        [90, "a"],
        [70, "b"],
      ]),
      { kind: "direct", best: "a", contenders: ["a"] },
    );
  });

  it("suggests when the top score is grey-zone", () => {
    const decision = decide([
      [70, "a"],
      [68, "b"],
    ]);
    assert.equal(decision.kind, "suggest");
    assert.deepEqual(decision.contenders, ["a", "b"]);
  });

  it("suggests when the top score is high but contested", () => {
    const decision = decide([
      [90, "a"],
      [88, "b"],
    ]);
    assert.equal(decision.kind, "suggest");
    assert.deepEqual(decision.contenders, ["a", "b"]);
  });

  it("is none when nothing reaches the floor", () => {
    assert.deepEqual(decide([[50, "a"]]), { kind: "none", best: null, contenders: [] });
    assert.deepEqual(decide([]), { kind: "none", best: null, contenders: [] });
  });

  it("ranks by score descending, stably", () => {
    const decision = decide([
      [70, "a"],
      [80, "b"],
      [70, "c"],
    ]);
    assert.equal(decision.best, "b");
    assert.deepEqual(decision.contenders, ["b"]);
  });
});
