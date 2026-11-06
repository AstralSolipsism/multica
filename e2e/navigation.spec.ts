import { test, expect } from "@playwright/test";
import { appRail, loginAsDefault, waitForPageText } from "./helpers";

const ROUTE_CHANGE_TIMEOUT = 30000;

test.describe("Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsDefault(page);
    await page.waitForLoadState("networkidle");
  });

  test("rail navigation works", async ({ page }) => {
    const rail = appRail(page);
    await rail.getByRole("link", { name: "Inbox" }).click();
    await expect(page).toHaveURL(/\/inbox/, { timeout: ROUTE_CHANGE_TIMEOUT });
    await waitForPageText(page, "Inbox");
    // Each destination renames the browser tab after itself (MUL-6222).
    await expect(page).toHaveTitle("Inbox | Labrastro");

    // Team lands on its first page, Agents.
    await rail.getByRole("link", { name: "Team" }).click();
    await expect(page).toHaveURL(/\/agents/, { timeout: ROUTE_CHANGE_TIMEOUT });
    await waitForPageText(page, "Agents");
    await expect(page).toHaveTitle("Agents | Labrastro");

    // Work lands on its first page, Issues.
    await rail.getByRole("link", { name: "Work", exact: true }).click();
    await expect(page).toHaveURL(/\/issues/, { timeout: ROUTE_CHANGE_TIMEOUT });
    await waitForPageText(page, "Issues");
    await expect(page).toHaveTitle("Issues | Labrastro");
  });

  test("settings links navigate to General and Members", async ({ page }) => {
    await appRail(page).getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/settings/, { timeout: ROUTE_CHANGE_TIMEOUT });
    await waitForPageText(page, "Settings");

    const settingsNav = page.getByRole("navigation", { name: "Settings", exact: true });
    const general = settingsNav.getByRole("link", { name: "General", exact: true });
    const members = settingsNav.getByRole("link", { name: "Members", exact: true });

    await general.click();
    await expect(page).toHaveURL(/\/settings\?tab=workspace$/, { timeout: ROUTE_CHANGE_TIMEOUT });
    await expect(general).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(/^E2E Workspace /);

    await members.click();
    await expect(page).toHaveURL(/\/settings\?tab=members$/, { timeout: ROUTE_CHANGE_TIMEOUT });
    await expect(members).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
    await expect(page.getByText("E2E User", { exact: true })).toBeVisible();
  });

  test("agents page shows agent list", async ({ page }) => {
    await appRail(page).getByRole("link", { name: "Team" }).click();
    await expect(page).toHaveURL(/\/agents/, { timeout: ROUTE_CHANGE_TIMEOUT });
    await waitForPageText(page, "Agents");

    // Should show "Agents" heading
    await expect(page.locator("text=Agents").first()).toBeVisible();
  });
});
