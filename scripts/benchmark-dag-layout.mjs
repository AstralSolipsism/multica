import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { cpus, availableParallelism, totalmem, platform, release, loadavg } from "node:os";
import { resolve, extname } from "node:path";
import { parseArgs } from "node:util";
import { build } from "vite";
import { chromium } from "@playwright/test";
import { renderDagSvg } from "./dag-layout/render.mjs";

const { values } = parseArgs({ options: {
  fixture: { type: "string" }, "big-line": { type: "string" },
  snapshot: { type: "string" }, lines: { type: "string", default: "OL-71,OL-110,OL-155" }, focus: { type: "string" },
  output: { type: "string", default: "dag-layout-results" }, samples: { type: "string", default: "10" },
  "compare-all-edges": { type: "boolean", default: false },
} });
if (!values.fixture && !values.snapshot) throw new Error("Pass --fixture accept-5000.json or --snapshot graph.json");
const directory = resolve(values.output);
await mkdir(directory, { recursive: true });
const bundleDir = await mkdtemp(resolve(directory, ".browser-"));
await build({ configFile: false, logLevel: "error", define: { "process.env.NODE_ENV": '"production"' },
  build: { outDir: bundleDir, emptyOutDir: true, minify: true, lib: { entry: resolve("scripts/dag-layout/browser.ts"), formats: ["es"], fileName: () => "benchmark.js" } },
});
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/") { res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><title>DAG layout benchmark</title>"); return; }
  try {
    const file = resolve(bundleDir, `.${path}`);
    if (!file.startsWith(`${bundleDir}/`)) { res.writeHead(403).end(); return; }
    res.setHeader("Content-Type", extname(file) === ".js" ? "text/javascript" : "application/octet-stream");
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const read = async (file) => file ? JSON.parse(await readFile(file, "utf8")) : undefined;
  const input = { fixture: await read(values.fixture), bigLine: await read(values["big-line"]), snapshot: await read(values.snapshot), identifiers: values.lines.split(","), focus: values.focus, samples: Number(values.samples), compareAllEdges: values["compare-all-edges"] };
  const output = await page.evaluate(async (input) => {
    const api = await import("/benchmark.js");
    return input.snapshot ? { artifacts: await api.renderDagSnapshots(input.snapshot, input.identifiers, input.focus) } : api.runDagLayoutBenchmark(input.fixture, input.bigLine, input.samples, input.compareAllEdges);
  }, input);
  for (const [name, artifact] of Object.entries(output.artifacts)) {
    await writeFile(resolve(directory, `${name}.svg`), renderDagSvg(artifact, name));
    await writeFile(resolve(directory, `${name}.geometry.json`), JSON.stringify(artifact));
  }
  const cgroup = async (file) => { try { return (await readFile(`/sys/fs/cgroup/${file}`, "utf8")).trim(); } catch { return null; } };
  const report = { machine: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, availableCpus: availableParallelism(), cpuQuota: await cgroup("cpu.max"), memoryLimit: await cgroup("memory.max"), ramGiB: totalmem() / 2 ** 30, os: `${platform()} ${release()}`, node: process.version, chromium: browser.version(), loadavg: loadavg() }, ...output, artifacts: Object.keys(output.artifacts) };
  await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
  await rm(bundleDir, { recursive: true, force: true });
}
