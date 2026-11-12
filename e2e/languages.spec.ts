import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

/**
 * One full flow per language (spec B6): pick the language on the first screen, become the owner, open a call, run a
 * turn in the simulator in that language, then the customer's own page. Fails on any interface text shown without a
 * translation. Screenshots go to docs/screenshots/lang/.
 */
const LANGS = [
  { code: "en", name: "English", line: "Yes, send me the link please." },
  { code: "hi-IN", name: "हिन्दी", line: "हाँ, मुझे लिंक भेज दीजिए।" },
  { code: "id-ID", name: "Bahasa Indonesia", line: "Ya, tolong kirim tautannya." },
  { code: "pt-BR", name: "Português (Brasil)", line: "Sim, me mande o link, por favor." },
];
mkdirSync("docs/screenshots/lang", { recursive: true });

for (const L of LANGS) {
  test(`full flow in ${L.code}: first-screen picker, owner, call simulator, customer page; no untranslated text`, async ({ page }) => {
    test.setTimeout(120_000);
    const dict: Record<string, string> = L.code === "en" ? {} : JSON.parse(readFileSync(`web/src/i18n/${L.code}.json`, "utf8"));
    const T = (en: string) => dict[en] ?? en;
    await page.addInitScript(() => { localStorage.setItem("cb-tour-seen-owner", "1"); localStorage.setItem("cb-tour-seen-staff", "1"); });
    await page.goto("/");
    // The picker on the first screen: names are written in their own language.
    await page.getByRole("button", { name: /^Language: / }).first().click();
    await page.getByRole("menuitemradio", { name: L.name }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", L.code);
    await expect(page.getByRole("menu")).toHaveCount(0); // the closing menu is out of the picture
    await page.screenshot({ path: `docs/screenshots/lang/${L.code}-landing.png` });

    await page.goto("/try");
    await page.getByRole("button", { name: T("Skip the walkthrough") }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/try"));
    await page.goto("/today");
    await expect(page.locator("main h1").first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", L.code); // remembered across pages
    await page.screenshot({ path: `docs/screenshots/lang/${L.code}-today.png` });

    // A call that hasn't started, then one simulator turn in this language.
    await page.goto("/calls");
    await page.locator("main a[href^='/calls/']").first().waitFor();
    const hrefs = [...new Set(await page.locator("main a[href^='/calls/']").evaluateAll((as) => as.map((a) => a.getAttribute("href")!)))];
    let href = "";
    for (const h of hrefs.slice(0, 10)) {
      await page.goto(h);
      if (await page.getByRole("button", { name: T("Start in simulator") }).waitFor({ timeout: 4000 }).then(() => true, () => false)) { href = h; break; }
    }
    expect(href).not.toBe("");
    await page.getByRole("button", { name: T("Start in simulator") }).click();
    const box = page.getByLabel(T("What the customer says"));
    await box.fill(L.line);
    await page.getByRole("button", { name: T("Say it"), exact: true }).click();
    await expect(page.locator("main")).toContainText(L.line, { timeout: 20_000 });
    await page.screenshot({ path: `docs/screenshots/lang/${L.code}-call.png`, fullPage: true });

    // The customer's own page in this language, with payment text labelled machine-translated (not in English).
    const cust = await page.request.get("/api/app/customers", { headers: { accept: "application/json" } });
    const first = (await cust.json())[0];
    const detail = await (await page.request.get(`/api/app/customers/${first.id}`, { headers: { accept: "application/json" } })).json();
    await page.goto(detail.customer.link);
    await expect(page.locator("h1").first()).toBeVisible();
    if (L.code !== "en") await expect(page.getByText(T("Machine-translated")).first()).toBeVisible();
    await page.screenshot({ path: `docs/screenshots/lang/${L.code}-customer.png`, fullPage: true });

    const missing = await page.evaluate(() => (window as any).__cbI18n.missing());
    expect(missing, `interface text shown with no translation: ${JSON.stringify(missing)}`).toEqual([]);
  });
}
