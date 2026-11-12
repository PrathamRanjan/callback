import { expect, test, type Page } from "@playwright/test";

/**
 * The guided walkthrough that "Try the live demo" leads to (web/src/tour/story.ts): a card that says who you are,
 * then steps across pages, role-switch cards between Maya and Priya, and a judging-criteria note on the steps that
 * carry one. Each step must show on its own page and highlight a real part of it, and the walkthrough must end
 * cleanly. There is no skip button.
 */
const title = (page: Page) => page.locator(".driver-popover-title");
const next = (page: Page) => page.locator(".driver-popover-next-btn");
/** The step highlights a real part of the page, not a centred card with nothing behind it. */
const lit = (page: Page, key: string) => expect(page.locator(`.driver-active-element[data-tour^="${key}"]`)).toHaveCount(1);
const why = (page: Page) => page.locator(".driver-popover .cb-story-why");

test("story: landing → Try → the owner's walkthrough: rules, the call as Priya, back to Maya, Telegram, agents and more", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Try the live demo" }).first().click();
  await page.waitForURL("**/try");
  await expect(page.getByRole("button", { name: /Skip/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Start as the owner" }).click();

  await page.waitForURL("**/today");
  await expect(title(page)).toHaveText("You are Maya Chen, the owner");
  await expect(page.locator(".driver-popover-close-btn")).toBeHidden(); // no way to skip; Escape still ends it
  await expect(why(page)).toContainText("Impact");
  await next(page).click(); // "Start"
  await expect(title(page)).toHaveText("Your day at a glance");
  await lit(page, "today-kpis");
  await next(page).click();

  await page.waitForURL("**/rules");
  await expect(title(page)).toHaveText("Your rules: why it calls, and when");
  await lit(page, "policy");
  await expect(why(page)).toContainText("Technology");
  await next(page).click();

  await page.waitForURL("**/today");
  await expect(title(page)).toHaveText("The calls your agent will make");
  await lit(page, "today-ready");
  await next(page).click();

  await page.waitForURL(/\/calls\/call_/);
  await expect(title(page)).toHaveText("Now you're Priya");
  await expect(page.locator(".cb-story-switch")).toContainText("Maya, the owner");
  await expect(page.locator(".cb-story-switch")).toContainText("Priya, the customer");
  await next(page).click(); // "Answer the call"
  await expect(title(page)).toHaveText("Take Priya's call");
  await lit(page, "take-call");
  // An "act" step: a click inside the highlighted part frees the page, and the corner pill carries on.
  await page.locator('[data-tour="take-call"]').dispatchEvent("pointerdown");
  await expect(page.locator(".driver-popover")).toHaveCount(0);
  await expect(page.locator(".cb-story-pill")).toContainText("Step 6 of 16");
  await page.locator(".cb-story-next").click();

  await page.waitForURL(/\/c\//);
  await expect(title(page)).toHaveText("The page Priya gets");
  await lit(page, "portal");
  await next(page).click();
  await expect(title(page)).toHaveText("A scam text arrives");
  await lit(page, "portal-check");
  await next(page).click();

  await page.waitForURL("**/approvals");
  await expect(title(page)).toHaveText("Back to Maya");
  await next(page).click();
  await expect(title(page)).toHaveText("A charge over your limit");
  await lit(page, "approvals");
  // The walkthrough made sure a held charge is waiting, even in a reused demo.
  await expect(page.locator('[data-tour="approvals"]')).toContainText("$360");
  await next(page).click();

  for (const [path, t, key] of [["/messages", "Holds reach your phone", "messages"], ["/money", "Money, read back from PayPal", "money"], ["/ask", "Ask your agent anything", "ask-box"], ["/agents", "Your own assistant can use Callback too", "agents"]] as const) {
    await page.waitForURL(`**${path}`);
    await expect(title(page)).toHaveText(t);
    await lit(page, key);
    await next(page).click();
  }

  await page.waitForURL("**/today");
  await expect(title(page)).toHaveText("Built for everyone");
  await lit(page, "display-help");
  await next(page).click();
  await expect(title(page)).toHaveText("That's a day with Callback");
  await next(page).click(); // "Finish"
  await expect(page.locator(".driver-popover")).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("cb-story"))).toBeNull();
});

test("story: a second walkthrough in the same demo still has Priya's call to take and a hold to decide", async ({ page }) => {
  await page.goto("/try");
  await page.getByRole("button", { name: "Start as the owner" }).click();
  await page.waitForURL("**/today");
  await page.keyboard.press("Escape"); // Escape ends the walkthrough
  await expect(page.locator(".driver-popover")).toHaveCount(0);
  // Use the demo up: decline every held charge, so Approvals is empty.
  await page.goto("/approvals");
  const decline = page.locator('[data-tour="approvals"]').getByRole("button", { name: "Decline" });
  await expect(decline.first()).toBeVisible();
  while (await decline.count()) {
    await decline.first().click();
    await page.waitForTimeout(600);
  }
  await expect(page.locator('[data-tour="approvals"]')).not.toContainText("$360");
  // Starting again puts a fresh held charge back and makes Priya's call ready to take.
  await page.goto("/try");
  await page.getByRole("button", { name: "Start as the owner" }).click();
  await page.waitForURL("**/today");
  for (let i = 0; i < 4; i++) await next(page).click();
  await page.waitForURL(/\/calls\/call_/);
  await next(page).click();
  await lit(page, "take-call"); // the call can be taken again
  await page.keyboard.press("Escape");
  await page.goto("/approvals");
  await expect(page.locator('[data-tour="approvals"]')).toContainText("$360");
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
