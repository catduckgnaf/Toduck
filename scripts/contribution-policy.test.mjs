import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkPullRequest, unresolvedCodexThreads } from "./contribution-policy.mjs";

const body = `## Summary and user impact
The inbox stays full width when the menu opens.

## Verification and test results
- Checks run: npm test
Documentation: not needed
Reason: Internal comment only.
`;

test("Codex review threads must be resolved before merge", () => {
  const open = unresolvedCodexThreads([
    { isResolved: false, authors: ["chatgpt-codex-connector[bot]"] },
    { isResolved: true, authors: ["codex"] },
    { isResolved: false, authors: ["catduck"] },
  ]);
  assert.equal(open.length, 1);
});

test("a pull request needs a summary, checks, and a documentation decision", () => {
  assert.deepEqual(checkPullRequest({ body, files: [] }), []);
  assert.ok(checkPullRequest({ body: "hello", files: [] }).length >= 2);
});

test("untouched pull request template does not satisfy the contribution policy", () => {
  const template = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", ".github/PULL_REQUEST_TEMPLATE.md"),
    "utf8",
  );
  const errors = checkPullRequest({ body: template, files: ["README.md"] }).join("\n");
  assert.match(errors, /written summary/i);
  assert.match(errors, /verification evidence/i);
  assert.match(errors, /Documentation: must be/i);
});

test("empty checks and blank documentation reasons are rejected", () => {
  const noEvidence = body.replace("Checks run: npm test", "Checks run:");
  assert.match(checkPullRequest({ body: noEvidence }).join("\n"), /verification evidence/i);
  const noReason = body.replace("Reason: Internal comment only.", "Reason:");
  assert.match(checkPullRequest({ body: noReason }).join("\n"), /Reason: line/i);
  const unselectedDoc = body.replace("Documentation: not needed", "Documentation: updated | not needed");
  assert.match(checkPullRequest({ body: unselectedDoc, files: ["README.md"] }).join("\n"), /Documentation: must be/i);
});

test("requires meaningful summary content rather than headings and placeholders", () => {
  const emptySummary = body.replace("The inbox stays full width when the menu opens.", " ");
  assert.match(checkPullRequest({ body: emptySummary }).join("\n"), /written summary/i);
  const actualMarkdownChange = body.replace("Documentation: not needed", "Documentation: updated");
  assert.deepEqual(checkPullRequest({ body: actualMarkdownChange, files: ["README.md"] }), []);
  assert.match(checkPullRequest({ body: actualMarkdownChange, files: [] }).join("\n"), /changed Markdown file/i);
});
