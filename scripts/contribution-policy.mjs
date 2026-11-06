export function isCodexLogin(login) {
  return /codex/i.test(String(login || ""));
}

/** Unresolved Codex review threads block merge, including outdated ones. */
export function unresolvedCodexThreads(threads) {
  return (threads || []).filter((thread) => {
    if (thread.isResolved) return false;
    const authors = thread.authors || thread.comments?.map((comment) => comment.author) || [];
    return authors.some((author) => isCodexLogin(typeof author === "string" ? author : author?.login));
  });
}

export function checkPullRequest({ body = "", files = [] }) {
  const errors = [];
  const text = String(body);
  if (!/##\s+Summary/i.test(text) || text.replace(/<!--[\s\S]*?-->/g, "").trim().length < 40) {
    errors.push("Pull request needs a written summary.");
  }
  if (!/Checks run:/i.test(text)) {
    errors.push("Pull request needs verification evidence under 'Checks run:'.");
  }
  const doc = text.match(/Documentation:\s*(updated|not needed)/i);
  if (!doc) {
    errors.push("Documentation: must be 'updated' or 'not needed'.");
  } else if (doc[1].toLowerCase() === "updated" && !files.some((file) => file.endsWith(".md"))) {
    errors.push("Documentation: updated requires a changed Markdown file.");
  } else if (doc[1].toLowerCase() === "not needed" && !/Reason:/i.test(text)) {
    errors.push("Documentation: not needed requires a Reason: line.");
  }
  return errors;
}
