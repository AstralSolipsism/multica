// Run from the repository root: node docs/engineering/ol-1277-baseline-annotation-browser.mjs
// Synthetic section-anchor fixture using the real layout callbacks, not a full app benchmark.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import ts from "typescript";
import { chromium } from "@playwright/test";

const path = "packages/views/projects/components/engineering-baseline-reading-rail.tsx";
const baseline = "873ab8b4e";
const sources = {
  before: execFileSync("git", ["show", `${baseline}:${path}`], { encoding: "utf8" }),
  after: readFileSync(path, "utf8"),
};
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
try {
  const results = {};
  for (const [version, source] of Object.entries(sources)) {
    const helpers = source.slice(source.indexOf("export function layoutBaselineReadingRail"), source.indexOf("interface BaselineReadingRailProps"));
    const callback = source.slice(source.indexOf("    const layout = () => {"), source.indexOf("    const schedule = () => {"));
    const program = `${helpers.replace("export function", "function")}\nwindow.layout = (props, rail) => { const sections = props.sections; let frame = 0; ${callback}\nlayout(); };`;
    const compiled = ts.transpileModule(program, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(`<style>
      body { margin: 0; font: 14px sans-serif; }
      main { display: grid; grid-template-columns: 800px 320px; gap: 32px; padding: 24px; }
      article { height: 120px; } h3 { margin: 0; height: 28px; }
      aside { position: relative; } [data-reading-rail-item] { position: absolute; left: 0; right: 0; height: 72px; border: 1px solid; }
      </style><main><div id="articles">${Array.from({ length: 200 }, (_, i) => `<article data-baseline-section-key="section-${i}"><h3>Section ${i}</h3><div data-baseline-markdown>Document text</div></article>`).join("")}</div>
      <aside>${Array.from({ length: 50 }, (_, i) => `<div data-reading-rail-item="entry-${i}">Annotation ${i}</div>`).join("")}</aside></main>`);
    await page.addScriptTag({ content: compiled });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
    const start = await metrics();
    const layout = await page.evaluate(() => {
      const sections = Array.from({ length: 200 }, (_, i) => ({ key: `section-${i}`, anchor: `anchor-${i}` }));
      const entries = Array.from({ length: 50 }, (_, i) => ({ id: `entry-${i}`, anchor: { sectionAnchor: `anchor-${i}`, anchorKind: "section" } }));
      const rail = document.querySelector("aside");
      const times = [];
      for (let i = 0; i < 20; i++) {
        document.querySelector("#articles").style.paddingTop = `${i % 2}px`;
        const before = performance.now();
        window.layout({ sections, entries }, rail);
        times.push(performance.now() - before);
      }
      return { times, positions: Array.from(rail.children, (card) => card.style.top), minHeight: rail.style.minHeight };
    });
    const end = await metrics();
    results[version] = {
      layoutCount: end.LayoutCount - start.LayoutCount,
      layoutDurationMs: (end.LayoutDuration - start.LayoutDuration) * 1000,
      callbackMedianMs: [...layout.times].sort((a, b) => a - b)[10],
      positions: layout.positions, minHeight: layout.minHeight,
    };
    await page.close();
  }
  assert.deepEqual(results.after.positions, results.before.positions);
  assert.equal(results.after.minHeight, results.before.minHeight);
  for (const item of Object.values(results)) delete item.positions;
  console.log(JSON.stringify({ fixture: "200 sections, 50 cards, 20 relayouts", browser: browser.version(), ...results }, null, 2));
} finally {
  await browser.close();
}
