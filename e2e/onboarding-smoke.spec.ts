import { test, expect } from "@playwright/test";
import { TestApiClient } from "./fixtures";
import { waitForPageText } from "./helpers";

// Smoke test for the onboarding flow: welcome → workspace → runtime.
// The About-you questionnaire and the source question are intentionally
// absent — the persona questions were removed with the marketing surface,
// and source attribution moved out of the critical path (MUL-5159).
// Captures screenshots for review. Uses a unique email per run so the user
// is always a fresh, un-onboarded user landing on /onboarding.

const EMAIL = `onboarding-v4-${Date.now()}@localhost`;
const SHOTS_DIR = "../shots-rail";

test.use({ viewport: { width: 1440, height: 900 } });

test("onboarding — welcome → workspace → runtime", async ({ page }) => {
  const api = new TestApiClient();
  await api.login(EMAIL, "OBv4 Tester");
  const token = api.getToken();

  await page.addInitScript((t) => {
    localStorage.setItem("multica_token", t);
  }, token);
  await page.goto("/onboarding", { waitUntil: "domcontentloaded" });
  await waitForPageText(page, "Continue on web");

  // 1. Welcome screen
  await expect(page.getByRole("button", { name: "Continue on web" })).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: `${SHOTS_DIR}/01-welcome.png`, fullPage: false });

  // Continue on web lands directly on the workspace step.
  await page.getByRole("button", { name: "Continue on web" }).click();

  // 2. Workspace step — the first persisted step. The About-you
  //    questionnaire must not exist anywhere in the flow.
  await expect(page.getByRole("heading", { name: /Name your workspace/i })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("Which best describes you?")).toHaveCount(0);
  await expect(page.getByText("Tell us a bit about you.")).toHaveCount(0);
  // The rail names every step and marks the current one; the ordinal
  // counter it replaced is gone.
  await expect(page.locator('[data-slot="stepper-title"]')).toHaveText([
    "Workspace",
    "Meet Mizuki",
  ]);
  await expect(
    page.locator('[aria-current="step"]').filter({ hasText: "Workspace" }),
  ).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS_DIR}/02-workspace.png` });

  // 3. Runtime step — the rail marks "Meet Mizuki" current.
  await page.getByRole("textbox").first().fill(`Rail QA ${Date.now()}`);
  await page.getByRole("button", { name: /^Create /i }).click();
  await expect(
    page.locator('[aria-current="step"]').filter({ hasText: "Meet Mizuki" }),
  ).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS_DIR}/03-runtime.png` });
});

test("onboarding — zh-Hans renders Chinese labels", async ({ page, context, baseURL }) => {
  await context.addCookies([
    {
      name: "multica-locale",
      value: "zh-Hans",
      url: baseURL ?? "http://localhost:3000",
    },
  ]);
  const api = new TestApiClient();
  await api.login(`zh-${Date.now()}@localhost`, "中文用户");
  const token = api.getToken();

  await page.addInitScript((t) => localStorage.setItem("multica_token", t), token);
  await page.goto("/onboarding", { waitUntil: "domcontentloaded" });
  await waitForPageText(page, "在 web 端继续");

  // Click the CTA by name. `getByRole("button").first()` used to stand in for
  // it, but the welcome screen renders the pinned Log out button first in DOM
  // order — so this step was signing the user out and the assertions below
  // were waiting on a page that had already redirected to login.
  await page.getByRole("button", { name: "在 web 端继续" }).click();

  // Workspace step — Chinese headline, no About-you screen in between.
  await expect(page.getByRole("heading", { name: /给工作区起个名字/ })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("简单介绍一下你自己。")).toHaveCount(0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS_DIR}/03-workspace-zh.png` });
});
