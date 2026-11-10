import { expect, test } from "@playwright/test";

/** Screenshots for docs/screenshots at phone, tablet and desktop widths, light and dark. Run: SCREENS=1 npm run e2e -- screens */
test.skip(!process.env.SCREENS, "set SCREENS=1 to capture screenshots");

const SIZES = [
  { name: "375", width: 375, height: 812 },
  { name: "768", width: 768, height: 1024 },
  { name: "1440", width: 1440, height: 900 },
];

test("capture", async ({ browser }) => {
  test.setTimeout(300_000);
  // One owner session prepares a call with all three lanes filled and one held approval.
  const prep = await browser.newContext();
  await prep.addInitScript(() => localStorage.setItem("cb-tour-seen-owner", "1"));
  const p = await prep.newPage();
  await p.goto("/try");
  await p.getByRole("button", { name: "Be the owner" }).click();
  await expect(p.locator("[data-tour=today-kpis]")).toBeVisible();
  await p.getByRole("link", { name: /Priya Natarajan/ }).first().click();
  await p.getByRole("button", { name: "Start in simulator" }).click();
  await p.getByLabel("What the customer says").fill("Yes, send me the link to pay the deposit");
  await p.getByRole("button", { name: "Say it" }).click();
  await expect(p.locator("[data-tour=call-score]")).toContainText("Money gate: charge");
  const callUrl = p.url();
  await p.goto("/today");
  await p.getByRole("link", { name: /Harbour Dental/ }).first().click();
  await p.getByRole("button", { name: "Start in simulator" }).click();
  await p.getByLabel("What the customer says").fill("Sure, text me the link");
  await p.getByRole("button", { name: "Say it" }).click();
  await expect(p.locator("[data-tour=call-score]")).toContainText("Held for you");
  await p.getByRole("link", { name: "Their page" }).click();
  await expect(p).toHaveURL(/\/c\//);
  const portalUrl = p.url();
  const state = await prep.storageState();
  await prep.close();

  const pages = [
    { name: "landing", url: "/" },
    { name: "today", url: "/today" },
    { name: "call", url: new URL(callUrl).pathname },
    { name: "approvals", url: "/approvals" },
    { name: "money", url: "/money" },
    { name: "portal", url: new URL(portalUrl).pathname },
  ];
  for (const scheme of ["light", "dark"] as const) {
    for (const s of SIZES) {
      const ctx = await browser.newContext({ storageState: state, colorScheme: scheme, viewport: { width: s.width, height: s.height }, reducedMotion: "reduce" });
      await ctx.addInitScript(() => localStorage.setItem("cb-tour-seen-owner", "1"));
      const page = await ctx.newPage();
      for (const pg of pages) {
        await page.goto(pg.url);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(400);
        await page.screenshot({ path: `docs/screenshots/${pg.name}-${s.name}-${scheme}.png`, fullPage: s.name !== "1440" });
      }
      await ctx.close();
    }
  }
});
