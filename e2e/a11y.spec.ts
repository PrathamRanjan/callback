import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Accessibility checks (spec A7), run with the journeys. Each one fails on what the spec says must not happen, and
 * all of them are written to eval/a11y.json with the date, which /accessibility shows:
 *  - axe-core (WCAG 2.0/2.1/2.2 A and AA rules) on every page of every persona, light at 1280 px and dark at 375 px:
 *    fail on any serious or critical issue;
 *  - reflow: no sideways scroll at 320 px with the Largest text setting, nor at 640 px (what 200% browser zoom
 *    gives on a 1280 px screen);
 *  - no motion when the system asks for reduced motion;
 *  - a keyboard-only pass of the main money flow (the owner approves a held move), steps recorded;
 *  - every Display and help switch announced with its name and description;
 *  - one polite live region for payment status changes.
 */

const PUBLIC = ["/", "/judge", "/try", "/proof", "/ai", "/paypal", "/who-can-move-money", "/accessibility", "/agents"];
const OWNER = ["/today", "/ask", "/calls", "/customers", "/approvals", "/money", "/rules", "/safety", "/messages", "/evidence"];
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const out: any = { at: new Date().toISOString(), base: "", commit: null, tags: TAGS, axe: [], reflow: [], motion: null, keyboard: null, switches: null, live_region: null };

async function be(page: Page, who: "owner" | "front desk" | "customer") {
  await page.goto("/try");
  // The owner and customer cards start the guided walkthrough (tour/story.ts); tests that aren't about it skip or close it.
  if (who === "owner") await page.getByRole("button", { name: "Skip the walkthrough" }).click();
  else if (who === "front desk") await page.getByRole("button", { name: "Be the front desk" }).click();
  else {
    await page.getByRole("button", { name: "Start as the customer" }).click();
    await page.waitForURL(/\/c\//);
    await page.locator(".driver-popover-close-btn").click();
    await expect(page.locator(".driver-popover")).toHaveCount(0);
  }
  await page.waitForURL((u) => !u.pathname.startsWith("/try"));
}
async function quiet(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("cb-tour-seen-owner", "1");
    localStorage.setItem("cb-tour-seen-staff", "1");
  });
}
async function settle(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(300);
}
async function axe(page: Page, path: string, who: string, width: number, theme: "light" | "dark") {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(path);
  await settle(page);
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  out.axe.push({ page: path, who, width, theme, serious: bad.filter((v) => v.impact === "serious").length, critical: bad.filter((v) => v.impact === "critical").length, minor_or_moderate: r.violations.length - bad.length, rules: bad.map((v) => `${v.id} (${v.nodes.length})`) });
  return bad.map((v) => `${path} [${who} ${width}px ${theme}] ${v.id}: ${v.help} — ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`);
}
async function overflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}
async function reflow(page: Page, path: string, who: string) {
  const res: string[] = [];
  // 320 px wide with the Largest text setting.
  await page.setViewportSize({ width: 320, height: 800 });
  await page.evaluate(() => localStorage.setItem("cb-display", JSON.stringify({ text: "xl" })));
  await page.goto(path);
  await settle(page);
  const a = await overflow(page);
  out.reflow.push({ page: path, who, condition: "320 px, Largest text", over_px: a });
  if (a > 0) res.push(`${path} at 320 px with Largest text: ${a} px sideways`);
  // 640 px at normal text: the same layout width as 200% browser zoom on a 1280 px screen.
  await page.evaluate(() => localStorage.removeItem("cb-display"));
  await page.setViewportSize({ width: 640, height: 800 });
  await page.goto(path);
  await settle(page);
  const b = await overflow(page);
  out.reflow.push({ page: path, who, condition: "200% zoom (640 px of a 1280 px screen)", over_px: b });
  if (b > 0) res.push(`${path} at 200% zoom: ${b} px sideways`);
  return res;
}

/**
 * Each check saves its own section, with the time it ran, into eval/a11y.json before it asserts, so a failure is
 * recorded too and a re-run of one check keeps the others (Playwright starts a new worker after a failure).
 */
function save(...keys: string[]) {
  let file: any = {};
  try {
    file = JSON.parse(readFileSync("eval/a11y.json", "utf8"));
  } catch {
    /* first run */
  }
  let commit: string | null = null;
  try {
    commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    /* not a checkout */
  }
  const now = new Date().toISOString();
  file = { ...file, at: now, commit, tags: TAGS, base: process.env.E2E_URL ?? "a fresh local server (the e2e default)", sections: { ...(file.sections ?? {}) } };
  for (const k of keys) {
    file[k] = out[k];
    file.sections[k] = now;
  }
  file.summary = {
    pages_checked_with_axe: (file.axe ?? []).length,
    serious_or_critical: (file.axe ?? []).reduce((n: number, a: any) => n + a.serious + a.critical, 0),
    reflow_checks: (file.reflow ?? []).length,
    reflow_failures: (file.reflow ?? []).filter((r: any) => r.over_px > 0).length,
  };
  writeFileSync("eval/a11y.json", JSON.stringify(file, null, 1) + "\n");
}

test("axe: no serious or critical issue on any page, for a stranger, the owner, the front desk and a customer", async ({ page }) => {
  test.setTimeout(240_000);
  await quiet(page);
  const bad: string[] = [];
  for (const p of PUBLIC) bad.push(...(await axe(page, p, "stranger", 1280, "light")), ...(await axe(page, p, "stranger", 375, "dark")));
  await be(page, "owner");
  const callHref = await (async () => {
    await page.goto("/calls");
    await settle(page);
    return page.locator('a[href^="/calls/"]').first().getAttribute("href");
  })();
  const custHref = await (async () => {
    await page.goto("/customers");
    await settle(page);
    return page.locator('a[href^="/customers/"]').first().getAttribute("href");
  })();
  for (const p of [...OWNER, ...(callHref ? [callHref] : []), ...(custHref ? [custHref] : [])]) bad.push(...(await axe(page, p, "owner", 1280, "light")), ...(await axe(page, p, "owner", 375, "dark")));
  await page.context().clearCookies();
  await be(page, "front desk");
  bad.push(...(await axe(page, "/calls", "front desk", 1280, "light")), ...(await axe(page, "/today", "front desk", 375, "dark")));
  await page.context().clearCookies();
  await be(page, "customer");
  const portal = new URL(page.url()).pathname;
  bad.push(...(await axe(page, portal, "customer", 1280, "light")), ...(await axe(page, portal, "customer", 375, "dark")));
  save("axe");
  expect(bad, bad.join("\n")).toEqual([]);
});

test("reflow: no sideways scroll at 320 px with Largest text, nor at 200% zoom, on every primary page", async ({ page }) => {
  test.setTimeout(240_000);
  await quiet(page);
  const bad: string[] = [];
  await page.goto("/");
  for (const p of ["/", "/judge", "/accessibility", "/proof"]) bad.push(...(await reflow(page, p, "stranger")));
  await be(page, "owner");
  for (const p of ["/today", "/calls", "/money", "/approvals", "/ask", "/customers", "/rules"]) bad.push(...(await reflow(page, p, "owner")));
  await page.context().clearCookies();
  await be(page, "customer");
  bad.push(...(await reflow(page, new URL(page.url()).pathname, "customer")));
  save("reflow");
  expect(bad, bad.join("\n")).toEqual([]);
});

test("reduced motion: nothing animates when the system asks for less motion", async ({ page }) => {
  await quiet(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const pages = ["/", "/judge"];
  let running = 0;
  for (const p of pages) {
    await page.goto(p);
    await settle(page);
    running += await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && Number(a.effect?.getTiming().duration ?? 0) > 1).length);
  }
  await be(page, "owner");
  for (const p of ["/today", "/calls"]) {
    await page.goto(p);
    await settle(page);
    pages.push(p);
    running += await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && Number(a.effect?.getTiming().duration ?? 0) > 1).length);
  }
  out.motion = { pages, running_animations: running };
  save("motion");
  expect(running).toBe(0);
});

test("keyboard only: the owner approves a held move without a mouse", async ({ page }) => {
  await quiet(page);
  await be(page, "owner");
  // Set-up (not part of the keyboard pass): a $420 move held for the owner.
  await page.getByRole("link", { name: /Harbour Dental/ }).first().click();
  await page.getByRole("button", { name: "Start in simulator" }).click();
  await page.getByLabel("What the customer says").fill("Sure, text me the link");
  await page.getByRole("button", { name: "Say it" }).click();
  await expect(page.locator("[data-tour=call-score]")).toContainText("Held for you");
  await page.getByRole("button", { name: "End call" }).click();
  // The pass, Tab and Enter only: from a fresh load of Today, through the sidebar to Approvals, then the approval.
  await page.goto("/today");
  await settle(page);
  const steps: string[] = [];
  const tabTo = async (want: RegExp) => {
    for (let i = 0; i < 160; i++) {
      await page.keyboard.press("Tab");
      const f = await page.evaluate(() => {
        const a = document.activeElement as HTMLElement | null;
        if (!a || a === document.body) return null; // past the last control: the page itself, not a control
        const s = getComputedStyle(a);
        const ring = (s.outlineStyle !== "none" && s.outlineWidth !== "0px") || s.boxShadow !== "none";
        return { name: (a.getAttribute("aria-label") || a.innerText || a.getAttribute("title") || a.tagName).replace(/\s+/g, " ").trim().slice(0, 60), visible: ring };
      });
      if (!f) continue;
      steps.push(`${f.name}${f.visible ? "" : " (no visible focus)"}`);
      if (want.test(f.name)) return true;
    }
    return false;
  };
  expect(await tabTo(/^Needs you/), `Tab order: ${steps.join(" → ")}`).toBe(true);
  await page.keyboard.press("Enter");
  steps.push("Enter (opens Needs you, the approvals page)");
  await expect(page).toHaveURL(/\/approvals/, { timeout: 30_000 }); // an in-app navigation: no page load to wait for
  await settle(page);
  expect(await tabTo(/^Approve \$420\.00/), `Tab order: ${steps.join(" → ")}`).toBe(true);
  await page.keyboard.press("Enter");
  steps.push("Enter (approves)");
  await expect(page.getByText(/Approved\./).first()).toBeVisible();
  const noRing = steps.filter((s) => s.endsWith("(no visible focus)"));
  const tabs = steps.filter((s) => !s.startsWith("Enter")).length;
  out.keyboard = { flow: "from Today, the owner opens Needs you (approvals) in the sidebar and approves a held $420.00 move", tabs, steps, result: "approved, and the page says so", without_visible_focus: noRing.length };
  save("keyboard");
  expect(noRing, "every focused control shows a focus ring").toEqual([]);
});

test("Display and help: each switch is announced with its name and description; one polite region for payment status", async ({ page }) => {
  await quiet(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Display and help" }).first().click();
  const names = ["Stronger contrast", "Easier-to-read letters", "No movement", "Bigger buttons"];
  const got: { name: string; described: boolean }[] = [];
  for (const n of names) {
    const sw = page.getByRole("switch", { name: n });
    await expect(sw).toHaveCount(1);
    const desc = await sw.evaluate((el) => {
      const ids = (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
      return ids.map((i) => document.getElementById(i)?.textContent ?? "").join(" ").trim();
    });
    got.push({ name: n, described: desc.length > 0 });
  }
  await expect(page.getByRole("button", { name: "Close display and help" })).toBeVisible();
  out.switches = { checked: got, close_button: "Close display and help" };
  save("switches");
  expect(got.every((g) => g.described)).toBe(true);
  await page.keyboard.press("Escape");
  const regions = await page.locator("#cb-status-live[aria-live=polite]").count();
  out.live_region = { id: "cb-status-live", count: regions, announces: "payment and hold status changes on Money and on the customer's page" };
  save("live_region");
  expect(regions).toBe(1);
});
