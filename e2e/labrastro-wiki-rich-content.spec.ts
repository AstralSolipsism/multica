import { test, expect } from "@playwright/test";
import { TestApiClient } from "./fixtures";

test("Wiki rich text, source issue saves and nested issue navigation", async ({ page, context }, testInfo) => {
  test.setTimeout(240000);
  const api = new TestApiClient();
  const nonce = Date.now();
  await api.login(`wiki-rich-${nonce}@multica.ai`, "Wiki reviewer");
  const workspace = await api.ensureWorkspace("Wiki review", `wiki-rich-${nonce}`);
  await api.markUserOnboarded();
  const project = await api.createProject("Engineering handbook");
  const original = await api.createIssue("Document the network architecture", { project_id: project.id });
  const replacement = await api.createIssue("Review the deployment rules", { project_id: project.id });
  const headers = { Authorization: `Bearer ${api.getToken()}`, "X-Workspace-ID": workspace.id };
  const base = `${process.env.NEXT_PUBLIC_API_URL}/api/projects/${project.id}`;
  const request = async (path: string, method = "GET", data?: unknown) => {
    const response = await page.request.fetch(base + path, { method, headers, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const markdown = `## Rules\n\n采用**「家庭局域网 → 海外中继 → 固定家宽出口」**的架构。说明 ** 中文 ** 结束。\n\n==**高亮**== 与公式 $x^2$ 后续。\n\nSee **[[deployment|Deployment guide]]** and [${original.identifier}](mention://issue/${original.id}).\n\n| Region | Status |\n| --- | --- |\n| Primary | Ready |\n\n## Operations\n\nKeep this section unchanged.`;
  const url = `/${workspace.slug}/projects/${project.id}/engineering?page=handbook`;
  const issueLink = (id: string) => `a[href*="/issues/${id}"]`;
  const save = async (sourceIssue: string | null, section?: string) => {
    const response = page.waitForResponse((r) => r.url().includes("/baseline/pages/handbook") && r.request().method() === "PUT");
    await page.getByTestId("wiki-editor-save").click();
    const saved = await response;
    expect(saved.ok(), await saved.text()).toBe(true);
    expect(saved.request().postDataJSON()).toMatchObject({ source_issue_id: sourceIssue, ...(section ? { section } : {}) });
    await expect(page.getByTestId("wiki-editor-source")).toHaveCount(0);
    const read = await request("/baseline/pages/handbook");
    expect(read.revision.source_issue_id).toBe(sourceIssue);
    return read;
  };
  try {
    await request("/engineering", "PATCH", { enabled: true });
    await request("/baseline/pages", "POST", { slug: "deployment", title: "Deployment guide", content_markdown: "> __重点__ 和 _强调_，字段 some_field_name" });
    await request("/baseline/pages", "POST", { slug: "handbook", title: "Network architecture", content_markdown: markdown, source_issue_id: original.id });
    await context.addInitScript((token) => {
      localStorage.setItem("multica_token", token!);
      localStorage.setItem("multica:chat:isOpen", "false");
    }, api.getToken());
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(url);
    await expect(page.getByRole("heading", { name: "Rules", exact: true })).toBeVisible({ timeout: 60000 });
    await expect(page.locator('[data-wiki-markdown] strong').filter({ hasText: "中文" })).toHaveText("中文");
    await expect(page.locator('[data-wiki-markdown] mark strong')).toHaveText("高亮");
    await expect(page.locator("[data-math-source]")).toHaveAttribute("data-math-source", "$x^2$");
    await expect(page.locator('[data-wiki-markdown] table')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("wiki-reader.png") });
    const bodyChip = page.locator(`[data-wiki-markdown] ${issueLink(original.id)}`);
    await bodyChip.hover();
    await expect(page.locator('[data-slot="hover-card-content"]').getByText(original.title, { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("wiki-issue-hover.png") });

    // A whole-page field-only clear and set must publish even with identical Markdown.
    await page.getByTestId("wiki-edit-page").click();
    await expect(page.getByTestId("wiki-editor-source-issue")).toHaveValue(original.identifier);
    await page.getByTestId("wiki-editor-source-issue").fill("");
    expect((await save(null)).content_markdown).toBe(markdown);
    await page.getByTestId("wiki-edit-page").click();
    await page.getByTestId("wiki-editor-source-issue").fill(original.identifier);
    expect((await save(original.id)).content_markdown).toBe(markdown);

    // Section reads have their own revision binding; body-only saves preserve it.
    await page.locator('[data-wiki-edit-section="Rules"]').click();
    await expect(page.getByTestId("wiki-editor-source-issue")).toHaveValue(original.identifier);
    const sectionSource = await page.getByTestId("wiki-editor-source").inputValue();
    await page.getByTestId("wiki-editor-source").fill(`${sectionSource}\n\nReviewed section.`);
    await page.screenshot({ path: testInfo.outputPath("wiki-section-editor.png") });
    await save(original.id, "Rules");
    await page.locator('[data-wiki-edit-section="Rules"]').click();
    await expect(page.getByTestId("wiki-editor-source-issue")).toHaveValue(original.identifier);
    await page.getByTestId("wiki-editor-source-issue").fill(replacement.identifier);
    const updated = await save(replacement.id, "Rules");
    expect(updated.content_markdown).toContain("Keep this section unchanged.");
    await page.reload();
    await page.getByTestId("wiki-edit-page").click();
    await expect(page.getByTestId("wiki-editor-source-issue")).toHaveValue(replacement.identifier);
    await page.getByTestId("wiki-editor-source").fill(`${updated.content_markdown}\n\nPage reviewed.`);
    await save(replacement.id);
    await page.screenshot({ path: testInfo.outputPath("wiki-saved.png") });

    // A selection crossing strong/highlight/math must stay anchored on the server.
    await page.locator('[data-wiki-markdown] p').filter({ hasText: "高亮" }).evaluate((p) => {
      const range = document.createRange(); range.selectNodeContents(p);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      p.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    const panel = page.locator("[data-wiki-comments]");
    await panel.locator('[contenteditable="true"]').fill("Confirmed the formula and highlighted passage.");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(panel.getByText("Confirmed the formula and highlighted passage.")).toBeVisible();
    const threads = await request("/baseline/pages/handbook/threads?state=all");
    expect(threads.threads[0].anchor.exact).toBe("高亮 与公式 $x^2$ 后续。");
    expect(threads.threads[0].location.state).toBe("anchored");
    await page.screenshot({ path: testInfo.outputPath("wiki-anchored-comment.png") });

    // History rows retain keyboard activation; the nested link owns Enter/click.
    await page.goto(url);
    await page.getByRole("button", { name: /History \(/ }).click();
    const oldRow = page.locator('[data-wiki-history-item="1"]');
    await oldRow.focus(); await page.keyboard.press("Enter");
    await expect(oldRow).toHaveClass(/bg-canvas/);
    await page.screenshot({ path: testInfo.outputPath("wiki-history.png") });
    await oldRow.locator(issueLink(original.id)).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/issues/(${original.identifier}|${original.id})`), { timeout: 60000 });
    await page.goto(url);
    await page.getByRole("button", { name: /History \(/ }).click();
    await page.locator(`[data-wiki-history-item="1"] ${issueLink(original.id)}`).click();
    await expect(page).toHaveURL(new RegExp(`/issues/(${original.identifier}|${original.id})`), { timeout: 60000 });

    const overview = `/${workspace.slug}/projects/${project.id}/engineering`;
    await page.goto(overview);
    const activity = page.getByTestId("wiki-activity").getByTestId("handbook").first();
    await activity.locator(issueLink(replacement.id)).focus();
    await page.screenshot({ path: testInfo.outputPath("wiki-overview.png") });
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/issues/(${replacement.identifier}|${replacement.id})`), { timeout: 60000 });
    await page.goto(overview);
    await page.getByTestId("wiki-activity").getByTestId("handbook").first().locator(issueLink(replacement.id)).click();
    await expect(page).toHaveURL(new RegExp(`/issues/(${replacement.identifier}|${replacement.id})`), { timeout: 60000 });
    await page.goto(overview);
    await page.getByTestId("wiki-activity").getByTestId("handbook").first().focus();
    await page.keyboard.press("Space");
    await expect(page).toHaveURL(/page=handbook/);
    await expect(page.getByRole("heading", { name: "Rules", exact: true })).toBeVisible();
  } finally {
    await api.cleanup();
    await api.deleteWorkspace();
  }
});
