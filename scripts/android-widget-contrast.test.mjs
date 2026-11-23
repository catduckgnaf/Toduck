import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const layout = readFileSync(join(root, "android/app/src/main/res/layout/widget_today.xml"), "utf8");
const background = readFileSync(join(root, "android/app/src/main/res/drawable/widget_bg.xml"), "utf8");

function luminance(hex) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

test("all five Android widget task titles meet WCAG normal-text contrast", () => {
  const bg = background.match(/<solid\b[^>]*android:color="(#[0-9A-Fa-f]{6})"/)?.[1];
  assert.ok(bg, "widget background color must be present");
  const titles = [...layout.matchAll(/<TextView\b[^>]*android:id="@\+id\/title(\d)"[^>]*\/>/g)];
  assert.equal(titles.length, 5, "the five widget task rows must be covered");
  for (const [, index, ] of titles) {
    const xml = titles.find((match) => match[1] === index)?.[0] ?? "";
    const color = xml.match(/android:textColor="(#[0-9A-Fa-f]{6})"/)?.[1];
    assert.ok(color, "title" + index + " must declare a readable text color");
    assert.ok(
      contrastRatio(color, bg) >= 4.5,
      "title" + index + ": " + color + " on " + bg + " fails 4.5:1 contrast",
    );
  }
});
