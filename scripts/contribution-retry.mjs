/**
 * Pick the latest run for the current commit of each open PR.
 * Re-trying a failed workflow run only once avoids a noisy retry loop.
 */
export function selectReviewRetryCandidates(runs, openPullRequests) {
  const open = new Map(openPullRequests.map((pr) => [pr.number, pr]));
  const latest = new Map();
  const newestFirst = [...runs].sort(
    (a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0)
  );
  for (const run of newestFirst) {
    if (run.event !== "pull_request") continue;
    for (const linked of run.pull_requests || []) {
      const pr = open.get(linked.number);
      if (!pr || latest.has(pr.number)) continue;
      if (linked.head?.sha && pr.head?.sha && linked.head.sha !== pr.head.sha) continue;
      if (linked.head?.repo?.id && pr.head?.repo?.id && linked.head.repo.id !== pr.head.repo.id) continue;
      if (run.head_branch && pr.head?.ref && run.head_branch !== pr.head.ref) continue;
      latest.set(pr.number, { pr, run });
    }
  }
  return [...latest.values()].filter(({ run }) =>
    run.status === "completed" && run.conclusion === "failure" && Number(run.run_attempt) === 1
  );
}
