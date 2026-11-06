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
