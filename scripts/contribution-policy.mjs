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

/** Return the text belonging to a Markdown section, excluding later sections. */
function sectionText(text, heading) {
  const match = new RegExp(`^##[ \\t]+${heading}[^\\r\\n]*export function isCodexLogin(login) {
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

, "im").exec(text);
  if (!match) return "";
  const after = text.slice(match.index + match[0].length);
  return after.split(/^##[ \\t]+/m)[0].trim();
}

export function checkPullRequest({ body = "", files = [] }) {
  const errors = [];
  // Template comments and headers do not count as a completed PR description.
  const text = String(body).replace(/<!--[\\s\\S]*?-->/g, "");
  const summary = sectionText(text, "Summary");
  if (summary.length < 20) {
    errors.push("Pull request needs a written summary.");
  }

  const lines = text.split(/\\r?\\n/);
  const checkIndex = lines.findIndex((line) => /^[ \\t]*-?[ \\t]*Checks run:/i.test(line));
  if (checkIndex < 0) {
    errors.push("Pull request needs verification evidence under 'Checks run:'.");
  } else {
    const evidence = [lines[checkIndex].replace(/^[ \\t]*-?[ \\t]*Checks run:[ \\t]*/i, "")];
    for (let i = checkIndex + 1; i < lines.length; i++) {
      if (/^[ \\t]*(?:##[ \\t]+|-?[ \\t]*Checks not run(?: and why)?:|Documentation:|Reason:)/i.test(lines[i])) break;
      evidence.push(lines[i]);
    }
    if (evidence.join(" ").replace(/[\\s\\-*\\[\\]]/g, "").length < 5) {
      errors.push("Pull request needs verification evidence under 'Checks run:'.");
    }
  }

  const doc = /^[ \\t]*Documentation:[ \\t]*([^\\r\\n]*)/im.exec(text);
  const decision = doc?.[1]?.trim().toLowerCase() ?? "";
  if (decision !== "updated" && decision !== "not needed") {
    errors.push("Documentation: must be 'updated' or 'not needed'.");
  } else if (decision === "updated" && !files.some((file) => file.endsWith(".md"))) {
    errors.push("Documentation: updated requires a changed Markdown file.");
  } else if (decision === "not needed") {
    const reason = /^[ \\t]*Reason:[ \\t]*(.+)$/im.exec(text)?.[1]?.trim();
    if (!reason) errors.push("Documentation: not needed requires a Reason: line.");
  }
  return errors;
}
