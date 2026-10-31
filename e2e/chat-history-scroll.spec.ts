import { HTML_BLOCK_MESSAGE_KEY } from "../packages/views/editor/utils/html-block-document";
import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";

test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } });

// A local fixture with the real chat list, Virtuoso and browser layout. No
// backend or user account is needed; transcript requests are counted below.
let server: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  const labRequire = createRequire(new URL("../apps/ui-lab/package.json", import.meta.url));
  const react = (await import(labRequire.resolve("@vitejs/plugin-react"))).default;
  const tailwind = (await import(labRequire.resolve("@tailwindcss/vite"))).default;
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("../apps/ui-lab", import.meta.url)),
    plugins: [react(), tailwind()],
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = server.resolvedUrls!.local[0]!;
});
test.afterAll(async () => { await server?.close(); });

test("history retains its reading line through delayed media growth and older-page prepend", async ({ page }, testInfo) => {
  let transcriptRequests = 0;
  await page.route("**/api/tasks/*/messages", (route) => {
    transcriptRequests++;
    return route.fulfill({ json: [] });
  });
  await page.goto(`${origin}test/chat-history-browser.html`);
  const root = page.locator("[data-tab-scroll-root]");
  await expect(root).not.toHaveClass(/invisible/);
  await expect(page.locator("#message-count")).toHaveText("50");
  await expect(root).toHaveCSS("overflow-anchor", "none");
  await root.hover();
  await page.mouse.wheel(0, -350);
  await page.waitForTimeout(300);

  // Pick a paragraph inside a tall row. A delayed iframe/image may grow ABOVE
  // it in the same message, which a row-top-only anchor cannot preserve.
  const frame = root.locator("iframe").first();
  await expect(frame).toBeAttached();
  await expect(frame).not.toHaveClass(/invisible/);
  const mediaBefore = await frame.evaluate((el) => el.getBoundingClientRect().height);
  const reading = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-tab-scroll-root]")!;
    const top = root.getBoundingClientRect().top;
    const p = [...root.querySelectorAll("p")].find((p) => {
      const box = p.getBoundingClientRect();
      return box.top >= top && box.bottom < top + 500;
    })!;
    p.setAttribute("data-reading-line", "");
    return p.getBoundingClientRect().top;
  });
  await page.screenshot({ path: testInfo.outputPath("before-media-growth.png") });
  await frame.evaluate((el: HTMLIFrameElement, key) => {
    el.contentWindow!.postMessage("grow", "*");
    // Chromium throttles ResizeObserver in fully offscreen iframes. Request a
    // real bridge measurement to reproduce a late report from above the view.
    el.contentWindow!.postMessage({ [key]: 1, type: "measure" }, "*");
  }, HTML_BLOCK_MESSAGE_KEY);
  await expect.poll(() => frame.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(mediaBefore + 300);
  await page.waitForTimeout(300);
  await expect.poll(() => page.locator("[data-reading-line]").evaluate((el) => el.getBoundingClientRect().top)).toBeCloseTo(reading, 0);

  await page.screenshot({ path: testInfo.outputPath("after-media-growth.png") });

  // Exercise the real ResizeObserver path, after Virtuoso's upward-scroll
  // compensation has gone idle, with the same 120→480px growth as HTML.
  await page.evaluate(() => {
    const p = document.querySelector("[data-reading-line]")!;
    const media = document.createElement("div");
    media.style.height = "360px";
    p.before(media);
  });
  await expect.poll(() => page.locator("[data-reading-line]").evaluate((el) => el.getBoundingClientRect().top)).toBeCloseTo(reading, 0);
  expect(transcriptRequests).toBe(0);

  // Reach the first loaded page, then let the near-top callback prepend.
  await root.hover();
  await page.mouse.wheel(0, -100000);
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => {
    const root = document.querySelector("[data-tab-scroll-root]")!;
    const p = [...root.querySelectorAll("p")].find((p) => p.getBoundingClientRect().top >= 0)!;
    return { text: p.textContent!, top: p.getBoundingClientRect().top };
  });
  await expect(page.locator("#message-count")).toHaveText("100");
  await page.waitForTimeout(300);
  await expect(page.getByText(before.text, { exact: true })).toBeVisible();
  const after = await page.getByText(before.text, { exact: true }).evaluate((el) => el.getBoundingClientRect().top);
  expect(Math.abs(after - before.top)).toBeLessThan(2);
  expect(transcriptRequests).toBe(0);
  await page.getByRole("button", { name: "Execution process", exact: true }).first().click();
  await expect(page.getByText("No execution steps recorded.")).toBeVisible();
  expect(transcriptRequests).toBe(1);
});
