import assert from "node:assert/strict";
import { test } from "node:test";
import { selectReviewRetryCandidates } from "./contribution-retry.mjs";

const pr = { number: 7, head: { ref: "fix", sha: "current", repo: { id: 12 } } };
function run(overrides = {}) {
  return {
    id: 10, event: "pull_request", status: "completed", conclusion: "failure",
    run_attempt: 1, created_at: "2026-11-20T00:00:00Z", head_branch: "fix",
    pull_requests: [{ number: 7, head: { sha: "current", repo: { id: 12 } } }],
    ...overrides,
  };
}

test("retries the latest first-attempt failure for an open PR", () => {
  assert.deepEqual(selectReviewRetryCandidates([run()], [pr]).map(({ run }) => run.id), [10]);
});

test("never retries an old failure after a newer successful run", () => {
  assert.deepEqual(selectReviewRetryCandidates([
    run(), run({ id: 11, conclusion: "success", created_at: "2026-11-21T00:00:00Z" }),
  ], [pr]), []);
});

test("does not retry an already retried run, a closed PR, or a stale commit", () => {
  assert.deepEqual(selectReviewRetryCandidates([run({ run_attempt: 2 })], [pr]), []);
  assert.deepEqual(selectReviewRetryCandidates([run()], []), []);
  assert.deepEqual(selectReviewRetryCandidates([run({
    pull_requests: [{ number: 7, head: { sha: "stale" } }],
  })], [pr]), []);
  assert.deepEqual(selectReviewRetryCandidates([run({ head_branch: "elsewhere" })], [pr]), []);
});

test("ignores other workflow events", () => {
  assert.deepEqual(selectReviewRetryCandidates([run({ event: "schedule" })], [pr]), []);
});
