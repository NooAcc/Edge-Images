import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const OBSERVABILITY_SNIPPETS = [
  '/_vercel/insights/script.js',
  'data-sdkn="@vercel/analytics"',
  '/_vercel/speed-insights/script.js',
  'data-sdkn="@vercel/speed-insights"'
];

test("static pages include Vercel Analytics and Speed Insights scripts", async () => {
  for (const file of ["index.html", "docs/index.html"]) {
    const html = await readFile(file, "utf8");

    for (const snippet of OBSERVABILITY_SNIPPETS) {
      assert.match(html, new RegExp(escapeRegExp(snippet)), `${file} should include ${snippet}`);
    }
  }
});

test("package dependencies include Vercel observability packages", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));

  assert.equal(typeof packageJson.dependencies["@vercel/analytics"], "string");
  assert.equal(typeof packageJson.dependencies["@vercel/speed-insights"], "string");
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
