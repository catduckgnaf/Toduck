import { readFileSync } from "node:fs";
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

test("untouched PR template fails even if the PR changes Markdown", () => {
  const template = readFileSync(new URL("../.github/PULL_REQUEST_TEMPLATE.md", import.meta.url), "utf8");
  const errors = checkPullRequest({ body: template, files: ["README.md"] });
  assert.ok(errors.some((error) => /written summary/i.test(error)));
  assert.ok(errors.some((error) => /verification evidence/i.test(error)));
  assert.ok(errors.some((error) => /Documentation: choose exactly/i.test(error)));
});

test("template headings, HTML comments, and an empty checks label are not evidence", () => {
  const empty = [
    "## Summary and user impact",
    "<!-- This sentence is long enough to satisfy the old summary length check. -->",
    "## Verification and test results",
    "- Checks run:",
    "- Checks not run and why:",
    "## Documentation impact",
    "Documentation: not needed",
    "Reason:",
  ].join("\n");
  const errors = checkPullRequest({ body: empty, files: ["README.md"] });
  assert.equal(errors.length, 3);
});

test("a filled summary cannot excuse missing verification", () => {
  const incomplete = body.replace("- Checks run: npm test", "- Checks run:");
  assert.ok(
    checkPullRequest({ body: incomplete, files: [] }).some((error) =>
      /verification evidence/i.test(error),
    ),
  );
});

test("requires one exact documentation decision and a real reason", () => {
  const choice = body.replace("Documentation: not needed", "Documentation: updated | not needed");
  assert.ok(
    checkPullRequest({ body: choice, files: ["README.md"] }).some((error) =>
      /choose exactly/i.test(error),
    ),
  );

  const noReason = body.replace("Reason: Internal comment only.", "Reason:");
  assert.ok(
    checkPullRequest({ body: noReason, files: [] }).some((error) =>
      /substantive Reason/i.test(error),
    ),
  );
});

test("summary and evidence placeholders cannot count as actual content", () => {
  const placeholder = body
    .replace("The inbox stays full width when the menu opens.", "TODO: describe the change")
    .replace("- Checks run: npm test", "- Checks run: TBD");
  const errors = checkPullRequest({ body: placeholder, files: [] });
  assert.ok(errors.some((error) => /written summary/i.test(error)));
  assert.ok(errors.some((error) => /verification evidence/i.test(error)));
});

test("allows a documented reason for not running tests", () => {
  const explanation = body
    .replace("- Checks run: npm test", "- Checks run:")
    .replace("Documentation: not needed", "Documentation: not needed")
    .replace("Reason: Internal comment only.", "Reason: This is a CI-only change.")
    .replace(
      "## Verification and test results",
      "## Verification and test results\n- Checks not run and why: No local Node runtime is available.",
    );
  assert.deepEqual(checkPullRequest({ body: explanation, files: [] }), []);
});

test("documentation marked updated requires a changed Markdown file", () => {
  const documented = body.replace("Documentation: not needed", "Documentation: updated");
  assert.ok(
    checkPullRequest({ body: documented, files: ["src/main.ts"] }).some((error) =>
      /changed Markdown/i.test(error),
    ),
  );
  assert.deepEqual(checkPullRequest({ body: documented, files: ["CONTRIBUTING.md"] }), []);
});

test("accepts real multiline verification results", () => {
  const detailed = body.replace("- Checks run: npm test", "- Checks run:\n- npm test\n- npm run lint");
  assert.deepEqual(checkPullRequest({ body: detailed, files: [] }), []);
});
