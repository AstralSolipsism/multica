import { test, expect } from "@playwright/test";
import { TestApiClient } from "./fixtures";

test("Wiki selection comments, realtime replies, lifecycle and narrow deep links", async ({ page, context }, testInfo) => {
  test.setTimeout(180000);
  const api = new TestApiClient();
  const nonce = `${Date.now()}`;
  await api.login(`wiki-comments-${nonce}@multica.ai`, "Wiki reviewer");
  const workspace = await api.ensureWorkspace("Wiki comments test", `wiki-comments-${nonce}`);
  await api.markUserOnboarded();
  const project = await api.createProject("Wiki comments regression");
  const headers = { Authorization: `Bearer ${api.getToken()}`, "X-Workspace-ID": workspace.id };
  const base = `${process.env.NEXT_PUBLIC_API_URL}/api/projects/${project.id}`;
  const request = async (path: string, method: string, data?: unknown) => {
    const result = await page.request.fetch(base + path, { method, headers, data });
    expect(result.ok(), await result.text()).toBe(true);
    return result.json();
  };
  try {
    await request("/engineering", "PATCH", { enabled: true });
    await request("/baseline/pages", "POST", { slug: "discussion", title: "Architecture decisions", content_markdown: "## Rules\n\nA stable passage for collaborative review.\n\n### Child\n\nIndependent child text.\n\n## Operations\n\nKeep this section unchanged." });
    await context.addInitScript((token) => {
      localStorage.setItem("multica_token", token!);
      localStorage.setItem("multica:chat:isOpen", "false");
    }, api.getToken());
    await page.setViewportSize({ width: 1600, height: 1000 });
    const url = `/${workspace.slug}/projects/${project.id}/engineering?page=discussion`;
    await page.goto(url);
    await expect(page.getByRole("heading", { name: "Rules", exact: true })).toBeVisible({ timeout: 60000 });
    const originalHTML = await page.locator('[data-wiki-comment-section="Rules"] [data-wiki-markdown]').innerHTML();
    const watcher = await context.newPage();
    await watcher.setViewportSize({ width: 1600, height: 1000 });
    await watcher.goto(url);
    await expect(watcher.getByRole("heading", { name: "Rules", exact: true })).toBeVisible();
    await page.locator('[data-wiki-comment-section="Rules"] p').evaluate((p) => {
      const range = document.createRange(); range.setStart(p.firstChild!, 2); range.setEnd(p.firstChild!, 16);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      p.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    const panel = page.locator("[data-wiki-comments]");
    await expect(panel.getByText("stable passage", { exact: true })).toBeVisible();
    await panel.locator('[contenteditable="true"]').fill("Please clarify the ownership.");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(panel.getByText("Please clarify the ownership.", { exact: true })).toBeVisible();
    const list = await request("/baseline/pages/discussion/threads?state=all", "GET");
    const thread = list.threads[0];
    expect(thread.anchor.exact).toBe("stable passage");
    expect(thread.issue_id).toBeUndefined();
    await expect(watcher.locator("[data-wiki-comment-count]")).toHaveCount(1);
    expect(await page.locator('[data-wiki-comment-section="Rules"] [data-wiki-markdown]').innerHTML()).toBe(originalHTML);
    expect(await page.evaluate(() => CSS.highlights.size)).toBeGreaterThan(0);
    await watcher.locator("[data-wiki-comment-count]").click();
    const otherPanel = watcher.locator("[data-wiki-comments]");
    await otherPanel.locator('[contenteditable="true"]').fill("The project owner decides.");
    await otherPanel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(panel.getByText("The project owner decides.", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(watcher.locator("[data-wiki-comment-count]")).toHaveCount(0);
    await panel.getByRole("button", { name: "Reopen", exact: true }).click();
    await expect(watcher.locator("[data-wiki-comment-count]")).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("wiki-comments-wide.png") });
    await page.setViewportSize({ width: 860, height: 800 });
    await page.goto(`${url}&section=Rules&thread=${thread.id}`);
    await expect(panel.getByText("Please clarify the ownership.", { exact: true })).toBeVisible();
    const drawer = await page.locator("[data-wiki-outline-column]").boundingBox();
    expect(drawer?.x).toBeGreaterThanOrEqual(0);
    expect((drawer?.x ?? 0) + (drawer?.width ?? 0)).toBeLessThanOrEqual(860);
    await page.screenshot({ path: testInfo.outputPath("wiki-comments-narrow.png") });
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await watcher.close();
  } finally {
    await api.cleanup();
    await api.deleteWorkspace();
  }
});
