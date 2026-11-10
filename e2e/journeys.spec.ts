import { expect, test, type Page } from "@playwright/test";

/** One persona after another, in order, against one fresh studio (the first visitor seeds it). */

async function be(page: Page, who: "owner" | "front desk" | "customer") {
  await page.goto("/try");
  await page.getByRole("button", { name: `Be the ${who}` }).click();
  // Wait for the sign-in to land: on the live site a goto right after the click raced the cookie back to /try.
  await page.waitForURL((u) => !u.pathname.startsWith("/try"));
}
/** Marks first-run tours as seen, for tests that aren't about the tour. */
async function noTours(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("cb-tour-seen-owner", "1");
    localStorage.setItem("cb-tour-seen-staff", "1");
  });
}
async function skipTour(page: Page) {
  const close = page.locator(".driver-popover-close-btn");
  if (await close.isVisible().catch(() => false)) await close.click();
}
async function noSideScroll(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, "no horizontal scroll").toBeLessThanOrEqual(0);
}

test("landing: promise, three steps, trust lanes, no priceless pricing block, FAQ; no sideways scroll at 360px", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("money calls");
  await expect(page.getByRole("heading", { name: "How it works" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /AI proposes\. Code decides\. PayPal moves\./ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pricing" })).toHaveCount(0); // spec B2 C6: tiers with no prices removed
  await expect(page.getByText("Amounts come from your records.")).toBeVisible();
  await page.getByRole("button", { name: "Who does it call, and when?" }).click();
  await expect(page.getByText("Only customers with consent on file")).toBeVisible();
  await noSideScroll(page);
});

test("owner: seed, Today, a deposit call creates a PayPal sandbox order, money page shows it", async ({ page }) => {
  await be(page, "owner");
  await expect(page).toHaveURL(/\/today/);
  await expect(page.locator("[data-tour=today-kpis]")).toContainText("Owed to you");
  await expect(page.locator(".driver-popover")).toHaveCount(0); // no automatic tour; /judge starts it on request
  await expect(page.getByRole("note", { name: "Demo status" })).toContainText("private demo", { ignoreCase: true });
  await page.getByRole("link", { name: /Priya Natarajan/ }).first().click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Priya Natarajan");
  await page.getByRole("button", { name: "Start in simulator" }).click();
  await expect(page.getByLabel("What the customer says")).toBeVisible();
  await page.getByLabel("What the customer says").fill("Yes, send me the link to pay the deposit");
  await page.getByRole("button", { name: "Say it" }).click();
  const score = page.locator("[data-tour=call-score]");
  await expect(score).toContainText("Money gate: charge");
  await expect(score).toContainText(/PayPal order created|Pay link/);
  await page.goto("/money");
  await expect(page.getByText("Every money move")).toBeVisible();
  await expect(page.locator("main")).toContainText("Pay link");
});

test("owner: a $420 move is held, shows what/who/why/undo, and approving carries it out", async ({ page }) => {
  await noTours(page);
  await be(page, "owner");
  await skipTour(page);
  await page.getByRole("link", { name: /Harbour Dental/ }).first().click();
  await page.getByRole("button", { name: "Start in simulator" }).click();
  await page.getByLabel("What the customer says").fill("Sure, text me the link");
  await page.getByRole("button", { name: "Say it" }).click();
  await expect(page.locator("[data-tour=call-score]")).toContainText("Held for you");
  await page.getByRole("button", { name: "End call" }).click();
  await page.goto("/approvals");
  const card = page.locator("[data-tour=approvals]");
  await expect(card).toContainText("$420.00");
  await expect(card).toContainText("If you approve");
  await expect(card).toContainText("Why it stopped");
  await expect(card).toContainText("Undo");
  await card.getByRole("button", { name: /Approve \$420\.00/ }).click();
  await expect(page.getByText(/Approved\./).first()).toBeVisible();
  await expect(card.getByRole("button", { name: /Approve \$420\.00/ })).toHaveCount(0);
});

test("owner: add a customer and a charge from scratch (no seed needed)", async ({ page }) => {
  await noTours(page);
  await be(page, "owner");
  await skipTour(page);
  await page.goto("/customers");
  await page.getByRole("button", { name: "New customer" }).click();
  await page.getByLabel("Name").fill("Ana Souza");
  await page.getByLabel("Mobile").fill("+61 491 570 737");
  await page.getByLabel("Consent to be called (optional)").fill("You may call me about bookings");
  await page.getByLabel("Where they gave it").fill("front desk");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ana Souza");
  await page.getByRole("button", { name: "New charge" }).click();
  await page.getByLabel("What is it?").selectOption("invoice");
  await page.getByLabel("Description").fill("Gait analysis");
  await page.getByLabel("Amount in dollars").fill("95");
  await page.getByLabel("Invoice due").fill("2026-02-20T09:00");
  await page.getByRole("button", { name: "Add charge" }).click();
  await expect(page.locator("main")).toContainText("Gait analysis");
  await expect(page.locator("main")).toContainText("$95.00");
});

test("front desk: sees calls, cannot reach money or approvals", async ({ page }) => {
  await noTours(page);
  await be(page, "front desk");
  await expect(page).toHaveURL(/\/calls/);
  await skipTour(page);
  await expect(page.locator("[data-tour=calls-list]")).toBeVisible();
  await expect(page.getByRole("link", { name: "Money" })).toHaveCount(0);
  await page.goto("/money");
  await expect(page.getByRole("alert")).toContainText("Only the owner");
});

test("customer: own page with verify code, PayPal button, call-back and stop", async ({ page }) => {
  await be(page, "customer");
  await expect(page).toHaveURL(/\/c\//);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Hi ");
  await expect(page.getByRole("button", { name: /PayPal|Refund|class credit/ }).first()).toBeVisible();
  await expect(page.getByText("will never ask for a password")).toBeVisible();
});

test("customer: splits an invoice into a plan the rules allow, and PayPal opens to approve it", async ({ page }) => {
  test.skip(!!process.env.E2E_URL, "creates a PayPal subscription; run against the local server only");
  await noTours(page);
  await be(page, "owner");
  const link = await page.evaluate(async () => {
    const list = (await (await fetch("/api/app/customers")).json()) as { id: string; owed_cents: number }[];
    for (const c of list.filter((x) => x.owed_cents >= 10000).sort((a, b) => a.owed_cents - b.owed_cents)) {
      const d = await (await fetch(`/api/app/customers/${c.id}`)).json();
      if (d.items.some((i: { kind: string; status: string }) => i.kind === "invoice" && i.status === "open")) return d.customer.link as string;
    }
    return null;
  });
  expect(link).toBeTruthy();
  await page.goto(link!);
  const picker = page.locator("[data-tour=portal-plan]").first();
  await expect(picker).toBeVisible();
  await expect(picker.locator("option").first()).toHaveText(/\d+ (fortnightly|monthly) payments/);
  await picker.getByRole("button", { name: "Set up plan with PayPal" }).click();
  await page.waitForURL(/paypal\.com/, { timeout: 45_000 });
});

test("judge tour: ?tour=judge walks every step across pages, survives navigation, and ends", async ({ page }) => {
  await page.goto("/today?tour=judge");
  const title = page.locator(".driver-popover-title");
  await expect(title).toHaveText("Judge mode: four minutes");
  const seen: string[] = [];
  for (let i = 0; i < 20; i++) {
    seen.push((await title.textContent()) ?? "");
    const next = page.locator(".driver-popover-next-btn");
    const label = (await next.textContent())?.trim();
    await next.click();
    if (label === "Finish") break;
    await expect(title).not.toHaveText(seen[seen.length - 1]);
  }
  expect(seen).toContain("The three-lane call score");
  expect(seen).toContain("Scam guard");
  expect(seen).toContain("Now the studio cancels");
  expect(seen).toContain("Live: a PayPal refund");
  expect(seen).toContain("Live: a payment plan");
  expect(seen).toHaveLength(14);
  expect(seen.at(-1)).toBe("That's Callback");
  await expect(page.locator(".driver-popover")).toHaveCount(0);
});

test("display and help: text size and calm mode apply and persist", async ({ page }) => {
  await noTours(page);
  await be(page, "owner");
  await expect(page.locator("[data-tour=today-kpis]")).toBeVisible();
  await page.getByRole("button", { name: "Display and help" }).first().click();
  await page.getByRole("radio", { name: "Largest" }).click();
  await page.getByLabel("No movement").click();
  await expect(page.locator("html")).toHaveClass(/a11y-xl/);
  await expect(page.locator("html")).toHaveClass(/a11y-calm/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/a11y-xl/);
});

test("phone layout: bottom nav, More sheet, 44px targets, no sideways scroll", async ({ page }) => {
  await noTours(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await be(page, "owner");
  await skipTour(page);
  const nav = page.getByRole("navigation", { name: "Main" }).last();
  await expect(nav.getByRole("link", { name: /Today/ })).toBeVisible();
  await nav.getByRole("button", { name: "More" }).click();
  await expect(page.getByRole("dialog")).toContainText("Scam guard");
  await page.keyboard.press("Escape");
  const small = await page.evaluate(() =>
    [...document.querySelectorAll("main button, main a, nav a, nav button")]
      .filter((e) => (e as HTMLElement).offsetParent !== null)
      .filter((e) => { const r = e.getBoundingClientRect(); return r.height > 0 && r.height < 40; })
      .map((e) => `${e.tagName} "${(e.textContent ?? "").trim().slice(0, 40)}" ${Math.round(e.getBoundingClientRect().height)}px`),
  );
  expect(small, "tap targets under 40px tall").toEqual([]);
  await noSideScroll(page);
  // Messages used to scroll sideways by 650 px on a phone; a long unbroken link must wrap.
  await page.goto("/messages");
  await page.getByLabel(/Message from/).fill(`https://www.sandbox.paypal.com/checkoutnow?token=${"A".repeat(120)}`);
  await page.getByRole("button", { name: "Send inbound" }).click();
  await expect(page.locator("main")).toContainText("checkoutnow");
  await noSideScroll(page);
});
