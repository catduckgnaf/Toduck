import assert from "node:assert/strict";
import { test } from "node:test";
import { diffViolations, lineViolations } from "./us-spelling.mjs";

test("flags British color/honor spellings and keeps an allow marker", () => {
  assert.deepEqual(lineViolations("The colour and behaviour."), [
    ["colour", "color"],
    ["behaviour", "behavior"],
  ]);
  assert.deepEqual(lineViolations("Keep colour. <!-- us-spelling: allow colour -->"), []);
});

test("scans only added Markdown lines", () => {
  const diff = ["+++ b/README.md", "@@ -1 +1,2 @@", "-old colour", "+new colour", "+code identifier_colour stays", " context"].join("\n");
  const found = diffViolations(diff);
  assert.equal(found.length, 1);
  assert.match(found[0], /README.md:1: British spelling 'colour'/);
});

test("a bare exception in a description is limited to its own line", () => {
  assert.deepEqual(lineViolations("<!-- us-spelling: allow -->\nAnother colour."), [["colour", "color"]]);
  assert.deepEqual(lineViolations("First colour. <!-- us-spelling: allow -->\nSecond colour."), [["colour", "color"]]);
  assert.deepEqual(lineViolations("First colour. <!-- us-spelling: allow colour -->\nSecond colour."), [["colour", "color"]]);
});

test("a Markdown line starting with two literal plus signs cannot reset diff parsing", () => {
  const diff = [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1,4 @@",
    "+normal color",
    "+++ b/other.md has colour",
    "+follow-up behaviour",
    " context",
  ].join("\n");
  assert.deepEqual(diffViolations(diff), [
    "README.md:2: British spelling 'colour' -- use 'color' instead",
    "README.md:3: British spelling 'behaviour' -- use 'behavior' instead",
  ]);
});

test("non-Markdown changes do not leak into the next Markdown diff", () => {
  const diff = [
    "diff --git a/example.txt b/example.txt",
    "--- a/example.txt",
    "+++ b/example.txt",
    "@@ -1 +1 @@",
    "+colour",
    "diff --git a/notes.md b/notes.md",
    "--- a/notes.md",
    "+++ b/notes.md",
    "@@ -1 +1 @@",
    "+honour",
  ].join("\n");
  assert.deepEqual(diffViolations(diff), [
    "notes.md:1: British spelling 'honour' -- use 'honor' instead",
  ]);
});
