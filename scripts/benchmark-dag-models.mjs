import { readFile, writeFile } from "node:fs/promises";
import { availableParallelism, cpus, loadavg, totalmem, platform, release } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { build } from "vite";

const { values } = parseArgs({ options: {
  inspect: { type: "string" }, output: { type: "string" },
  "fixture-5000": { type: "string" }, "fixture-10000": { type: "string" },
} });
const readPayload = async (path) => path ? JSON.parse(await readFile(path, "utf8")) : undefined;

const output = await build({
  configFile: false, logLevel: "error",
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    write: false, minify: true,
    lib: { entry: fileURLToPath(new URL("../packages/core/issues/dag/benchmark.ts", import.meta.url)), name: "DagBench", formats: ["iife"] },
  },
});
const bundle = (Array.isArray(output) ? output[0] : output).output.find((item) => item.type === "chunk");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.addScriptTag({ content: bundle.code });
  const input = {
    inspect: await readPayload(values.inspect),
    fixture5000: await readPayload(values["fixture-5000"]),
    fixture10000: await readPayload(values["fixture-10000"]),
    fixture: values["fixture-5000"],
  };
  const result = await page.evaluate((input) => input.inspect
    ? window.DagBench.inspectDagOverview(input.inspect)
    : window.DagBench.benchmarkDagModels(input.fixture5000, input.fixture10000, input.fixture), input);
  const report = {
    measuredAt: new Date().toISOString(),
    machine: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, availableCpus: availableParallelism(), loadAverage: loadavg(), memoryGiB: totalmem() / 1024 ** 3, os: `${platform()} ${release()}`, browser: browser.version(), node: process.version },
    result,
  };
  const json = JSON.stringify(report, null, 2);
  if (values.output) await writeFile(values.output, `${json}\n`);
  console.log(json);
} finally {
  await browser.close();
}
