import { expect, test, type Page } from "@playwright/test";

/**
 * The guided walkthrough that "Try the live demo" leads to (web/src/tour/story.ts): a card that says who you are,
 * then steps across pages. Each step's popover must appear on its own page, and the walkthrough must end cleanly.
 */
const title = (page: Page) => page.locator(".driver-popover-title");
const next = (page: Page) => page.locator(".driver-popover-next-btn");
/** The step highlights a real part of the page, not a centred card with nothing behind it. */
const lit = (page: Page, key: string) => expect(page.locator(`.driver-active-element[data-tour^="${key}"]`)).toHaveCount(1);

test("story: landing → Try → owner walkthrough visits Today, the call, the customer page, Approvals, Money and Ask", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Try the live demo" }).first().click();
  await page.waitForURL("**/try");
  await page.getByRole("button", { name: "Start as the owner" }).click();

  await page.waitForURL("**/today");
  await expect(title(page)).toHaveText("You are Maya Chen, the owner");
  await next(page).click(); // "Start"
  await expect(title(page)).toHaveText("Your day at a glance");
  await lit(page, "today-kpis");
  await next(page).click();
  await expect(title(page)).toHaveText("The calls your agent will make");
  await lit(page, "today-ready");
  await next(page).click();

  await page.waitForURL(/\/calls\/call_/);
  await expect(title(page)).toHaveText(/^Now you're \S+, the customer$/);
  await lit(page, "take-call");
  // An "act" step: a click inside the highlighted part frees the page, and the corner pill carries on.
  await page.locator('[data-tour="take-call"], [data-tour="call-sim"]').first().dispatchEvent("pointerdown");
  await expect(page.locator(".driver-popover")).toHaveCount(0);
  await expect(page.locator(".cb-story-pill")).toContainText("Step 4 of 10");
  await page.locator(".cb-story-next").click();

  await page.waitForURL(/\/c\//);
  await expect(title(page)).toHaveText(/^The page \S+ gets$/);
  await lit(page, "portal");
  await next(page).click();
  await expect(title(page)).toHaveText("A scam text arrives");
  await lit(page, "portal-check");
  await next(page).click();

  await page.waitForURL("**/approvals");
  await expect(title(page)).toHaveText("A charge over your limit");
  await lit(page, "approvals");
  await next(page).click();
  await page.waitForURL("**/money");
  await expect(title(page)).toHaveText("Money, read back from PayPal");
  await lit(page, "money");
  await next(page).click();
  await page.waitForURL("**/ask");
  await expect(title(page)).toHaveText("Ask your agent anything");
  await lit(page, "ask-box");
  await next(page).click();

  await page.waitForURL("**/today");
  await expect(title(page)).toHaveText("That's a day with Callback");
  await next(page).click(); // "Finish"
  await expect(page.locator(".driver-popover")).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("cb-story"))).toBeNull();
});

test("story: the customer walkthrough opens the customer's page with a role card, and leaving the page ends it", async ({ page }) => {
  await page.goto("/try");
  await page.getByRole("button", { name: "Start as the customer" }).click();
  await page.waitForURL(/\/c\//);
  await expect(title(page)).toHaveText(/^You are \S+, a customer$/);
  await next(page).click();
  await expect(title(page)).toHaveText("Pay the way you like");
  await page.goto("/judge"); // not one of the story's pages
  await expect(page.locator(".driver-popover")).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("cb-story"))).toBeNull();
});

test("story: Skip the walkthrough signs in as the owner with no popover", async ({ page }) => {
  await page.goto("/try");
  await page.getByRole("button", { name: "Skip the walkthrough" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/try"));
  await page.waitForTimeout(800);
  await expect(page.locator(".driver-popover")).toHaveCount(0);
});
