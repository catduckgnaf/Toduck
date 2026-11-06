import assert from "node:assert/strict";
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
