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

function stripComments(text) {
  return String(text || "").replace(/<!--[\s\S]*?-->/g, "");
}

function sectionContent(text, title) {
  let active = false;
  const content = [];
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      if (active) break;
      active = heading[1] === "##" && heading[2].toLowerCase().startsWith(title.toLowerCase());
    } else if (active) {
      content.push(line);
    }
  }
  return content.join("\n");
}

function fieldContent(text, label) {
  const start = new RegExp("^[ \\t]*(?:[-*][ \\t]+)?" + label + ":[ \\t]*(.*)$", "i");
  const boundary = /^[ \t]*(?:[-*][ \t]+)?(?:Checks run|Checks not run and why|Documentation|Reason):/i;
  const content = [];
  let active = false;
  for (const line of text.split(/\r?\n/)) {
    if (!active) {
      const match = line.match(start);
      if (!match) continue;
      active = true;
      content.push(match[1]);
    } else {
      if (/^[ \t]*#{1,6}[ \t]+/.test(line) || boundary.test(line)) break;
      content.push(line);
    }
  }
  return content.join(" ");
}

function hasSubstance(value, minimumLength) {
  const prose = value
    .replace(/^[ \t]*[-*+][ \t]+/gm, " ")
    .replace(/[`*_>#~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^(?:todo|tbd|placeholder)\b/i.test(prose)) return false;
  if (/^(?:n\/a|none|not applicable|fill this in|describe here)[.!]?\s*$/i.test(prose)) {
    return false;
  }
  return prose.length >= minimumLength;
}

export function checkPullRequest({ body = "", files = [] }) {
  const errors = [];
  const text = stripComments(body);

  // Validate the Summary section itself, not the length of the full template.
  if (!hasSubstance(sectionContent(text, "Summary"), 20)) {
    errors.push("Pull request needs a written summary describing the change and user impact.");
  }

  // A bare "Checks run:" label is not verification. A reason for not running
  // checks is acceptable when tests cannot be executed locally.
  const checks = fieldContent(text, "Checks run");
  const notRun = fieldContent(text, "Checks not run and why");
  if (!hasSubstance(checks, 6) && !hasSubstance(notRun, 12)) {
    errors.push("Pull request needs verification evidence under 'Checks run:' or a reason under 'Checks not run and why:'.");
  }

  // The untouched template offers both options; the author must select one.
  const docLine = text.match(/^[ \t]*(?:[-*][ \t]+)?Documentation:[ \t]*(.*)$/im);
  const decision = docLine?.[1].trim().toLowerCase();
  if (decision !== "updated" && decision !== "not needed") {
    errors.push("Documentation: choose exactly 'updated' or 'not needed'.");
  } else if (decision === "updated" && !files.some((file) => file.endsWith(".md"))) {
    errors.push("Documentation: updated requires a changed Markdown file.");
  } else if (decision === "not needed" && !hasSubstance(fieldContent(text, "Reason"), 10)) {
    errors.push("Documentation: not needed requires a substantive Reason: line.");
  }

  return errors;
}
