import { expect, test } from "@playwright/test";

/** "Connect your assistant" on /agents (spec C): a demo key for the owner only, hidden until asked, and a live log. */
test("agents: a stranger is offered a demo; the owner gets a hidden demo key, a real MCP call from the page, and the log shows it", async ({ page }) => {
  await page.goto("/agents");
  await expect(page.getByRole("heading", { name: "Connect your assistant" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Be the owner" })).toBeVisible();
  await expect(page.getByTestId("demo-key")).toHaveCount(0);

  await page.addInitScript(() => { localStorage.setItem("cb-tour-seen-owner", "1"); localStorage.setItem("cb-tour-seen-staff", "1"); });
  await page.goto("/try");
  await page.getByRole("button", { name: "Skip the walkthrough" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/try"));
  await page.goto("/agents");
  const panel = page.getByTestId("connect-assistant");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("demo-key")).toHaveText("••••••••••••"); // not shown until asked
  await expect(panel.locator("pre")).not.toContainText("cbo_");
  await expect(page.getByTestId("mcp-empty")).toBeVisible();
  await page.getByRole("button", { name: "Try it from here: call get_plan" }).click();
  await expect(page.getByText(/get_plan answered/)).toBeVisible();
  const log = page.getByTestId("mcp-log");
  await expect(log).toContainText("get_plan");
  await expect(log).toContainText("agents-page-test");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByTestId("demo-key")).not.toHaveText("••••••••••••");
});
