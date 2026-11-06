// American spellings for the color/honor family. The one list to extend.
export const BRITISH_TO_US = {
  colour: "color",
  colours: "colors",
  coloured: "colored",
  colouring: "coloring",
  honour: "honor",
  honours: "honors",
  honoured: "honored",
  honouring: "honoring",
  honourable: "honorable",
  behaviour: "behavior",
  behaviours: "behaviors",
  favour: "favor",
  favours: "favors",
  favoured: "favored",
  favouring: "favoring",
  favourite: "favorite",
  favourites: "favorites",
  neighbour: "neighbor",
  neighbours: "neighbors",
  neighbouring: "neighboring",
  recognise: "recognize",
  recognises: "recognizes",
  recognised: "recognized",
  recognising: "recognizing",
  organise: "organize",
  organises: "organizes",
  organised: "organized",
  organising: "organizing",
};

const pattern = new RegExp(`\\b(${Object.keys(BRITISH_TO_US).sort((a, b) => b.length - a.length).join("|")})\\b`, "gi");

function replacement(found) {
  const next = BRITISH_TO_US[found.toLowerCase()];
  if (found === found.toUpperCase()) return next.toUpperCase();
  if (found[0] === found[0].toUpperCase()) return next[0].toUpperCase() + next.slice(1);
  return next;
}

export function lineViolations(text) {
  const allow = text.match(/<!--\s*us-spelling:\s*allow\b(.*?)-->/i);
  const words = allow ? [...allow[1].matchAll(/[A-Za-z]+/g)].map((word) => word[0].toLowerCase()) : [];
  if (allow && words.length === 0) return [];
  const prose = text.replace(/<!--.*?-->/g, "");
  const found = [];
  for (const match of prose.matchAll(pattern)) {
    if (!words.includes(match[0].toLowerCase())) found.push([match[0], replacement(match[0])]);
  }
  return found;
}

export function diffViolations(diffText) {
  const found = [];
  let path = null;
  let line = 0;
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("+++")) {
      const target = raw.slice(4).trim().replace(/^b\//, "");
      path = target.endsWith(".md") ? target : null;
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!path) continue;
    if (raw.startsWith("+")) {
      for (const [word, next] of lineViolations(raw.slice(1))) found.push(`${path}:${line}: British spelling '${word}' -- use '${next}' instead`);
      line += 1;
    } else if (!raw.startsWith("-") && !raw.startsWith("\\")) {
      line += 1;
    }
  }
  return found;
}
