import { expect, test, type Page } from "@playwright/test";

/**
 * Hands-free "Look and Say" (spec A). Simulated gaze (?hf=sim) drives the real controller: the same snapping, dwell,
 * confirm card and voice-command path as the camera, with the gaze point set by the test instead of a face.
 * The last test runs the real camera path on Chromium's fake camera (no face in it), which proves the MediaPipe
 * runtime and model load and that "no face" pauses rather than presses.
 */
// Chromium's fake camera (a test pattern, no face) for the camera test; the simulated-gaze tests don't open it.
test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] }, permissions: ["camera"] });

async function owner(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("cb-tour-seen-owner", "1");
    localStorage.setItem("cb-tour-seen-staff", "1");
    localStorage.setItem("cb-hf", JSON.stringify({ mode: "gaze", dwellMs: 700, voice: "off" }));
  });
  await page.goto("/try");
  await page.getByRole("button", { name: "Be the owner" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/try"));
}
async function lookAt(page: Page, name: string | RegExp) {
  const el = page.getByRole("button", { name }).or(page.getByRole("link", { name })).first();
  await el.scrollIntoViewIfNeeded();
  const b = (await el.boundingBox())!;
  await page.evaluate(([x, y]) => ((window as any).__cbHfSim = { x, y }), [b.x + b.width / 2, b.y + b.height / 2]);
}
const lookAway = (page: Page) => page.evaluate(() => ((window as any).__cbHfSim = null));
async function say(page: Page, text: string) {
  await page.waitForFunction(() => Boolean((window as any).__cbHf));
  await page.evaluate((t) => (window as any).__cbHf.say(t), text);
}

test("simulated gaze: a call needs the confirm card; cancel leaves it; Confirm needs twice the dwell; a plain link presses; Hindi stop", async ({ page }) => {
  await owner(page);
  // A call that hasn't started yet: open call pages until one offers "Start in simulator".
  await page.goto("/calls");
  await page.locator("main a[href^='/calls/']").first().waitFor();
  const hrefs = [...new Set(await page.locator("main a[href^='/calls/']").evaluateAll((as) => as.map((a) => a.getAttribute("href")!)))];
  let href = "";
  for (const h of hrefs.slice(0, 10)) {
    await page.goto(h);
    if (await page.getByRole("button", { name: "Start in simulator" }).waitFor({ state: "visible", timeout: 4000 }).then(() => true, () => false)) { href = h; break; }
  }
  expect(href, "a call that can start").not.toBe("");
  await page.goto(`${href}?hf=sim`);
  await expect(page.getByTestId("hf-status")).toContainText("Simulated gaze");
  const start = page.getByRole("button", { name: "Start in simulator" });
  await expect(start).toBeVisible();

  // Looking at "Start in simulator" (it places a call) fills the ring, then stops at the card instead of pressing.
  await lookAt(page, "Start in simulator");
  const card = page.getByRole("alertdialog");
  await expect(card).toContainText("places a call");
  await lookAway(page);
  await say(page, "cancel");
  await expect(card).toBeHidden();
  await expect(page.getByTestId("hf-live")).toContainText("Not done");
  await expect(start).toBeVisible(); // nothing happened

  // Again, and confirm by looking at Confirm: one dwell (0.7 s) isn't enough there, two are.
  await lookAt(page, "Start in simulator");
  await expect(card).toBeVisible();
  await lookAt(page, "Confirm");
  await page.waitForTimeout(1000);
  await expect(card).toBeVisible();
  await expect(card).toBeHidden({ timeout: 4000 });
  await lookAway(page);
  await expect(start).toBeHidden({ timeout: 15_000 });

  // A plain link presses with no card: look at "Calls" in the sidebar.
  await lookAt(page, /^Calls/);
  await page.waitForURL(/\/calls$/);

  // "stop" in Hindi turns it off at once.
  await say(page, "रुको");
  await expect(page.getByTestId("hf-status")).toBeHidden();
});

test("simulated gaze: the card shows the button's own question; Esc cancels; voice runs commands in English and Portuguese and sends questions to Ask", async ({ page }) => {
  await owner(page);
  await page.goto("/demo?hf=sim");
  await lookAt(page, "Reset, demo morning");
  const card = page.getByRole("alertdialog");
  await expect(card).toContainText("Reset the demo studio?"); // the button's own question, on the card
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await lookAway(page);
  // Voice: page commands, and an unknown sentence goes to Ask as a question to check first.
  await say(page, "open customers");
  await page.waitForURL(/\/customers$/);
  await say(page, "who owes money this week");
  await page.waitForURL(/\/ask\?q=/);
  await expect(page.getByRole("textbox").first()).toHaveValue("who owes money this week");
  // The same in Brazilian Portuguese, with the page in Portuguese.
  await page.goto("/today?lang=pt-BR&hf=sim");
  await say(page, "abrir clientes");
  await page.waitForURL(/\/customers$/);
  await page.goto("/today?lang=en&hf=sim");
  // Esc with no card open turns hands-free off.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("hf-status")).toBeHidden();
});

test("hands-free is off by default and the core pages don't load its code", async ({ page }) => {
  await owner(page);
  const loaded: string[] = [];
  page.on("request", (r) => { if (/controller-|vision_bundle|mediapipe/.test(r.url())) loaded.push(r.url()); });
  for (const p of ["/today", "/calls", "/money"]) {
    await page.goto(p);
    await expect(page.locator("main h1").first()).toBeVisible();
  }
  expect(loaded).toEqual([]);
  await expect(page.getByTestId("hf-status")).toHaveCount(0);
  // Alt+Shift+H turns it on; in this headless browser the camera opens Chromium's fake device or falls back.
  await page.getByRole("button", { name: /Hands-free: look and say/ }).click();
  await expect(page.getByTestId("hf-status")).toBeVisible();
  await page.getByRole("button", { name: "Stop hands-free" }).click();
  await expect(page.getByTestId("hf-status")).toHaveCount(0);
});

test.describe("real camera path", () => {
  test("MediaPipe loads on the fake camera; with no face in view it pauses and never presses", async ({ page }) => {
    test.setTimeout(120_000);
    await owner(page);
    await page.addInitScript(() => localStorage.setItem("cb-hf", JSON.stringify({ mode: "head", dwellMs: 700, voice: "off", debug: true })));
    await page.goto("/today");
    const wasm: number[] = [];
    page.on("response", (r) => { if (r.url().includes("/mediapipe/") && r.url().endsWith(".wasm")) wasm.push(r.status()); });
    await page.keyboard.press("Alt+Shift+H");
    await expect(page.getByTestId("hf-status")).toContainText("Camera on, on this device only", { timeout: 60_000 });
    await expect(page.getByTestId("hf-status")).toContainText("Paused: look back at the screen", { timeout: 30_000 });
    expect(wasm).toContain(200);
    await expect(page.getByRole("region", { name: "Hands-free debug panel" })).toContainText("face: false");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });
});
