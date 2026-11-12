// Live smoke check for the 12 Nov extras on a deployed Callback, with one private demo (the site allows 5 new demos
// an hour per address, so the full browser suite runs locally and this runs on production):
// the language picker and ?lang=, the owner's pages in Portuguese, /agents (demo key hidden, one real MCP call shown
// in the log), hands-free on simulated gaze with its confirm card, and /accessibility#hands-free.
// Usage: node scripts/live-smoke-lang-hf.mjs [base url]. Screenshots go to data/live-smoke/ (not committed).
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

const BASE = (process.argv[2] ?? "https://pph-callback.onrender.com").replace(/\/$/, "");
const PT = JSON.parse(readFileSync("web/src/i18n/pt-BR.json", "utf8"));
const T = (en) => PT[en] ?? en;
mkdirSync("data/live-smoke", { recursive: true });
const rows = [];
const record = (check, ok, detail) => {
  rows.push({ check, ok, detail });
  console.error(`${ok ? "PASS" : "FAIL"}  ${check} — ${detail}`);
};
const step = async (check, fn) => {
  try { await fn(); } catch (e) { record(check, false, String(e.message).split("\n")[0].slice(0, 200)); }
};

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
await ctx.addInitScript(() => { localStorage.setItem("cb-tour-seen-owner", "1"); localStorage.setItem("cb-tour-seen-staff", "1"); });
const p = await ctx.newPage();
const health = await (await fetch(`${BASE}/healthz`)).json();
console.error(`target ${BASE}, commit ${String(health.commit).slice(0, 7)}`);

await step("?lang=pt-BR on the first screen switches the page, with no sign-in", async () => {
  await p.goto(`${BASE}/?lang=pt-BR`);
  await p.waitForFunction(() => document.documentElement.lang === "pt-BR", null, { timeout: 20000 });
  const h1 = (await p.locator("h1").first().innerText()).replace(/\s+/g, " ");
  record("?lang=pt-BR on the first screen switches the page, with no sign-in", /ligações|pagamentos/i.test(h1), `html lang pt-BR; h1 "${h1.slice(0, 80)}"`);
});

await step("one tap starts a private demo, and the owner's Today page is in Portuguese", async () => {
  await p.goto(`${BASE}/try`);
  await p.getByRole("button", { name: T("Be the owner") }).click();
  await p.waitForURL((u) => !u.pathname.startsWith("/try"), { timeout: 60000 });
  const err = new URL(p.url()).searchParams.get("err");
  if (err) throw new Error(`no demo: ${err}`);
  await p.goto(`${BASE}/today`);
  await p.locator("main h1").first().waitFor();
  const h1 = await p.locator("main h1").first().innerText();
  const missing = await p.evaluate(() => window.__cbI18n?.missing?.() ?? null);
  await p.screenshot({ path: "data/live-smoke/pt-today.png" });
  record("one tap starts a private demo, and the owner's Today page is in Portuguese", h1.trim() === T("Today") && Array.isArray(missing) && missing.length === 0, `h1 "${h1}"; untranslated strings on the page: ${missing === null ? "unknown" : missing.length}`);
});

await step("/agents: the demo key is hidden until Show, and one real MCP call appears in the log", async () => {
  await p.goto(`${BASE}/agents?lang=en`);
  await p.getByTestId("connect-assistant").waitFor({ timeout: 20000 });
  await p.waitForFunction(() => /^\u2022+$/.test(document.querySelector("[data-testid=demo-key]")?.textContent?.trim() ?? ""), null, { timeout: 20000 }).catch(() => undefined);
  const masked = (await p.getByTestId("demo-key").innerText()).trim();
  await p.getByRole("button", { name: "Try it from here: call get_plan" }).click();
  await p.getByTestId("mcp-log").waitFor({ timeout: 30000 });
  const first = await p.getByTestId("mcp-log").locator("tbody tr").first().innerText();
  await p.screenshot({ path: "data/live-smoke/agents.png" });
  record("/agents: the demo key is hidden until Show, and one real MCP call appears in the log", /^•+$/.test(masked) && /get_plan/.test(first) && /OK/.test(first), `key shown as ${masked.length} dots; newest row: ${first.replace(/\s+/g, " ").slice(0, 120)}`);
});

await step("hands-free on simulated gaze: a call button raises the confirm card; Cancel leaves the call unstarted", async () => {
  await p.goto(`${BASE}/calls`);
  await p.locator("main a[href^='/calls/']").first().waitFor();
  const hrefs = [...new Set(await p.locator("main a[href^='/calls/']").evaluateAll((as) => as.map((a) => a.getAttribute("href"))))];
  let href = null;
  for (const h of hrefs.slice(0, 10)) {
    await p.goto(BASE + h);
    if (await p.getByRole("button", { name: "Start in simulator" }).waitFor({ timeout: 5000 }).then(() => true, () => false)) { href = h; break; }
  }
  if (!href) throw new Error("no call that can start");
  await p.goto(`${BASE}${href}?hf=sim`);
  await p.getByTestId("hf-status").waitFor({ timeout: 30000 });
  await p.waitForFunction(() => Boolean(window.__cbHf), null, { timeout: 20000 });
  const r = await p.getByRole("button", { name: "Start in simulator" }).boundingBox();
  for (let i = 0; i < 90; i++) {
    await p.evaluate(([x, y]) => (window.__cbHfSim = { x, y }), [r.x + r.width / 2 + (Math.random() - 0.5) * 16, r.y + r.height / 2 + (Math.random() - 0.5) * 16]);
    await p.waitForTimeout(33);
    if (await p.getByRole("alertdialog").isVisible()) break;
  }
  const card = await p.getByRole("alertdialog").isVisible();
  await p.screenshot({ path: "data/live-smoke/handsfree-card.png" });
  if (card) await p.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await p.waitForTimeout(800);
  const still = await p.getByRole("button", { name: "Start in simulator" }).isVisible();
  record("hands-free on simulated gaze: a call button raises the confirm card; Cancel leaves the call unstarted", card && still, `card ${card ? "shown" : "not shown"}; after Cancel the call ${still ? "has not started" : "STARTED"}`);
  await p.evaluate(() => window.__cbHf?.say("stop"));
});

await step("/accessibility#hands-free: the recording, the simulated demo and the benchmark load for a stranger", async () => {
  const s = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const q = await s.newPage();
  await q.goto(`${BASE}/accessibility#hands-free`);
  await q.locator("#hands-free").waitFor({ timeout: 20000 });
  const video = await q.locator("#hands-free video").count();
  const src = await q.locator("#hands-free video source, #hands-free video").first().evaluate((v) => v.currentSrc || v.getAttribute("src") || v.querySelector("source")?.getAttribute("src") || "");
  const vr = src ? await fetch(new URL(src, BASE)).then((r) => `${r.status} ${r.headers.get("content-type")} ${Math.round(Number(r.headers.get("content-length") ?? 0) / 1024)} KB`) : "no src";
  const table = await q.locator("#hands-free table").count();
  record("/accessibility#hands-free: the recording, the simulated demo and the benchmark load for a stranger", video > 0 && /^200 video\/webm/.test(vr) && table > 0, `video ${vr}; tables ${table}`);
  await s.close();
});

await b.close();
console.log(`\n| Check | Result | What was seen |\n|---|---|---|`);
for (const r of rows) console.log(`| ${r.check} | ${r.ok ? "pass" : "FAIL"} | ${String(r.detail).replace(/\|/g, "/")} |`);
process.exit(rows.every((r) => r.ok) ? 0 : 1);
