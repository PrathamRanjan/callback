// Records the 30-second hands-free clip shown on /accessibility (spec A9), from simulated gaze in a headless browser.
// No person and no camera: the gaze point is set by this script, through the same controller the camera drives.
//   node scripts/record-handsfree.mjs http://localhost:3512   → web/public/media/handsfree-demo.webm
import { chromium } from "@playwright/test";
import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:3512";
const out = "web/public/media/handsfree-demo.webm";
const tmp = "data/hf-video";
rmSync(tmp, { recursive: true, force: true });
const b = await chromium.launch();
const init = () => {
  localStorage.setItem("cb-tour-seen-owner", "1");
  localStorage.setItem("cb-tour-seen-staff", "1");
  localStorage.setItem("cb-hf", JSON.stringify({ mode: "gaze", dwellMs: 1100, voice: "off" }));
};
// Set-up, not recorded: sign in as the demo owner and find a call that hasn't started.
const setup = await b.newContext({ viewport: { width: 1100, height: 700 } });
await setup.addInitScript(init);
const s0 = await setup.newPage();
await s0.goto(`${base}/try`);
await s0.getByRole("button", { name: "Be the owner" }).click();
await s0.waitForURL((u) => !u.pathname.startsWith("/try"));
await s0.goto(`${base}/calls`);
await s0.locator("main a[href^='/calls/']").first().waitFor();
const hrefs = [...new Set(await s0.locator("main a[href^='/calls/']").evaluateAll((as) => as.map((a) => a.getAttribute("href"))))];
let href = null;
for (const h of hrefs.slice(0, 10)) {
  await s0.goto(base + h);
  if (await s0.getByRole("button", { name: "Start in simulator" }).waitFor({ timeout: 4000 }).then(() => true, () => false)) { href = h; break; }
}
if (!href) throw new Error("no startable call");
const state = await setup.storageState();
await setup.close();

// The recording: straight onto that call, hands-free on simulated gaze.
const ctx = await b.newContext({ viewport: { width: 1100, height: 700 }, storageState: state, recordVideo: { dir: tmp, size: { width: 1100, height: 700 } } });
await ctx.addInitScript(init);
const p = await ctx.newPage();
const t0 = Date.now();
await p.goto(`${base}${href}?hf=sim`);
await p.getByTestId("hf-status").waitFor();

// A wandering, jittery gaze toward a point, like an eye settling on a target.
async function glide(to, ms = 900) {
  const from = await p.evaluate(() => window.__cbHfSim ?? { x: 550, y: 350 });
  const n = Math.round(ms / 33);
  for (let i = 1; i <= n; i++) {
    const k = i / n, e = k * k * (3 - 2 * k);
    await p.evaluate(([x, y]) => (window.__cbHfSim = { x, y }), [from.x + (to.x - from.x) * e + (Math.random() - 0.5) * 24, from.y + (to.y - from.y) * e + (Math.random() - 0.5) * 24]);
    await p.waitForTimeout(33);
  }
}
async function hold(ms) {
  const c = await p.evaluate(() => window.__cbHfSim);
  const n = Math.round(ms / 33);
  for (let i = 0; i < n; i++) {
    await p.evaluate(([x, y]) => (window.__cbHfSim = { x, y }), [c.x + (Math.random() - 0.5) * 30, c.y + (Math.random() - 0.5) * 30]);
    await p.waitForTimeout(33);
  }
}
const centre = async (loc) => { const r = await loc.boundingBox(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };

await p.evaluate(() => (window.__cbHfSim = { x: 560, y: 420 }));
await hold(1500);
await glide(await centre(p.getByRole("button", { name: "Start in simulator" })), 1200);
await hold(2600); // the ring fills; the card stops it
await glide(await centre(p.getByRole("alertdialog").getByRole("button", { name: "Cancel" })), 900);
await hold(1800); // cancelled: nothing happened
await glide(await centre(p.getByRole("button", { name: "Start in simulator" })), 900);
await hold(2600);
await glide(await centre(p.getByRole("alertdialog").getByRole("button", { name: "Confirm" })), 900);
await hold(3600); // twice the dwell on Confirm
await p.getByRole("button", { name: "Start in simulator" }).waitFor({ state: "hidden", timeout: 10000 }).catch(() => undefined);
await hold(1500);
await glide(await centre(p.getByRole("link", { name: /^Calls/ }).first()), 1100);
await hold(2200); // a plain link: no card
await p.waitForURL(/\/calls$/).catch(() => undefined);
await hold(1500);
const row = p.locator("main a[href^='/calls/']").nth(1);
await glide(await centre(row), 1100);
await hold(1200);
await p.evaluate(() => window.__cbHf.say("stop"));
await p.waitForTimeout(Math.max(1500, 30000 - (Date.now() - t0) - 4000));
const v = p.video();
await ctx.close();
await b.close();
mkdirSync("web/public/media", { recursive: true });
renameSync(await v.path(), out);
rmSync(tmp, { recursive: true, force: true });
console.log(out, Math.round(statSync(out).size / 1024), "KB");
