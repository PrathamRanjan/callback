// Live check for the PayPal calls a demo does not make on its own (spec A3.2: /paypal shows a live sandbox id per
// API). In one fresh private demo it does what a visitor does: asks for a PayPal invoice on a call, splits an
// invoice into a payment plan on the customer's page, and takes a refund for the cancelled class (which the seed
// paid from the saved sandbox wallet). Then it reads /api/public/paypal. Nothing here signs in to PayPal: the plan's
// subscription is created and waits for the buyer's approval on PayPal's page, which needs a buyer login.
// It also measures call-turn latency and turns the demo's own "make the AI fail" switch on and off (spec A11).
// Usage: node scripts/live-paypal-coverage.mjs [base url]
const BASE = (process.argv[2] ?? "https://pph-callback.onrender.com").replace(/\/$/, "");
const rows = [];
const record = (item, check, ok, detail) => { rows.push({ item, check, ok, detail }); console.error(`${ok ? "PASS" : "FAIL"}  ${item}: ${check} — ${detail}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jar = new Map();
async function req(method, path, body, kind = "form") {
  const headers = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), accept: "application/json" };
  if (body) headers["content-type"] = kind === "json" ? "application/json" : "application/x-www-form-urlencoded";
  const res = await fetch(BASE + path, { method, redirect: "manual", headers, body: body ? (kind === "json" ? JSON.stringify(body) : new URLSearchParams(body)) : undefined });
  for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, location: res.headers.get("location"), json, text };
}
const get = (p) => req("GET", p);
const post = (p, f = {}) => req("POST", p, f);

const commit = String((await get("/healthz")).json?.commit ?? "").slice(0, 7);
await post("/demo/signin-as", { role: "owner" });
// Wait for the seed's wallet payments (Tom's class booking is one), up to 90 s.
let sess;
for (let i = 0; i < 45; i++) { sess = (await get("/api/app/session")).json; if (/3 of 3/.test(sess?.workspace?.seed_note ?? "")) break; await sleep(2000); }
record("A2.1", "the new demo's seed payments are confirmed by PayPal", /3 of 3/.test(sess?.workspace?.seed_note ?? ""), sess?.workspace?.seed_note ?? "no note");

const customers = (await get("/api/app/customers")).json ?? [];
const link = async (name) => { const c = customers.find((x) => x.name.startsWith(name)); return c ? (await get(`/api/app/customers/${c.id}`)).json?.customer?.link : null; };

// 1. Refund: Tom's cancelled class was paid from the saved wallet, so the refund goes back to that capture.
const tom = await link("Tom");
const tp = (await get(`/api/app${tom}`)).json;
const cls = tp?.open?.find((o) => o.kind === "class_cancel");
const rf = cls ? await post(`${tom}/settle/${cls.id}`, { choice: "refund" }) : { location: "no class" };
const rmsg = decodeURIComponent(String(rf.location ?? "").split("ok=")[1] ?? rf.location ?? "");
record("A3.2", "refund of the cancelled class goes back to its PayPal capture", /sent to the PayPal account/.test(rmsg), `paid by PayPal ${cls?.paid_by_paypal}; ${rmsg.slice(0, 120)}`);

// 2. Plan: Lena's $180 invoice split into a plan the rules allow. PayPal answers with its approval page.
const lena = await link("Lena");
const lp = (await get(`/api/app${lena}`)).json;
const inv = lp?.open?.find((o) => o.kind === "invoice");
const opt = inv?.plans?.[0];
const pl = inv && opt ? await post(`${lena}/plan/${inv.id}`, { option: opt.id }) : { location: "no plan option" };
record("A3.2", "a payment plan creates a real product, plan and subscription waiting for the buyer", /paypal\.com/.test(pl.location ?? ""), `${opt?.label ?? "no option"} → ${String(pl.location ?? "").replace(/token=[^&]+/, "token=…").slice(0, 70)}`);

// 3. Invoice: the call about Tom's overdue $220 invoice (under the $300 the rules let the agent send unasked),
// where the customer asks for a PayPal invoice instead of a link.
const tomId = customers.find((x) => x.name.startsWith("Tom"))?.id;
const tomCalls = tomId ? (await get(`/api/app/customers/${tomId}`)).json?.calls ?? [] : [];
const hc = tomCalls.find((c) => c.status === "planned" && /invoice/.test(c.purpose));
let said = [];
let invoiceId = null;
if (hc) {
  await post(`/calls/${hc.id}/place`, { mode: "simulator" });
  await post(`/calls/${hc.id}/say`, { text: "Hi, yes, this is Tom." });
  await post(`/calls/${hc.id}/say`, { text: "I can't pay by link right now. Please just send me a PayPal invoice by email and I'll pay it on Friday." });
  const d = (await get(`/api/app/calls/${hc.id}`)).json;
  said = (d?.call?.transcript ?? []).filter((t) => t.who !== "customer" && t.who !== "system").map((t) => t.text);
  invoiceId = d?.item?.paypal_invoice_id ?? null;
}
record("A3.2", "a customer who asks for an invoice on a call gets a real PayPal invoice", Boolean(invoiceId), `call ${hc ? hc.purpose : "none planned"}; agent: "${(said.at(-1) ?? "").slice(0, 120)}"; invoice ${invoiceId ?? "none"}`);

// 4. /paypal now shows those ids.
const pp = (await get("/api/public/paypal")).json;
const row = (re) => pp?.apis?.find((a) => re.test(a.api));
const show = (a) => (a?.live ? `${a.live.id}${a.live.extra ? ` (${a.live.extra})` : ""}` : a?.error ? "error" : "none yet");
const inv2 = row(/Invoicing/), sub = row(/Subscriptions/), ref = row(/refund/), oa = row(/OAuth/);
record("A3.2", "/paypal shows a live sandbox id for invoices, plans and refunds", [inv2, sub, ref].every((a) => a?.live), `OAuth: ${show(oa)}; Invoicing: ${show(inv2)}; Subscriptions: ${show(sub)}; Refund: ${show(ref)}`);

record("A3.2", "/paypal: the OAuth row shows when this server last got a token (never the token)", Boolean(oa?.live?.at) && !/^A21|Bearer/.test(oa?.live?.id ?? ""), `${show(oa)}, ${oa?.live?.at ?? "no time"}`);

// 5. Call-turn speed: each model call's own latency, from /ai (your demo, shown in full).
const mine = (await get("/api/public/ai")).json?.yours ?? [];
const turnsMs = mine.filter((x) => x.purpose === "turn" && x.ok).map((x) => x.latency_ms).sort((a, b) => a - b);
const med = turnsMs.length ? turnsMs[Math.floor(turnsMs.length / 2)] : null;
record("A4", "call-turn model latency measured per call (no target: recorded)", turnsMs.length > 0, `${turnsMs.length} call turns; median ${med} ms, slowest ${turnsMs.at(-1)} ms, fastest ${turnsMs[0]} ms`);

// 6. The honest failure, live (spec A11): the demo's own switch makes every model call fail for two minutes.
const arm = await post("/demo/fault-ai");
const armed = decodeURIComponent(String(arm.location ?? ""));
const lc = (await get(`/api/app/customers/${customers.find((x) => x.name.startsWith("Marcus"))?.id}`)).json?.calls?.find((c) => c.status === "planned");
let fail = null;
if (lc) {
  const pl2 = await post(`/calls/${lc.id}/place`, { mode: "simulator" });
  const said2 = lc ? await post(`/calls/${lc.id}/say`, { text: "Yes, I can pay now." }) : null;
  const d2 = (await get(`/api/app/calls/${lc.id}`)).json;
  fail = { place: decodeURIComponent(String(pl2.location ?? "")), status: d2?.call?.status, outcome: d2?.call?.outcome, last: (d2?.call?.transcript ?? []).at(-1)?.text ?? "", said: said2?.status };
}
record("A11", "with the AI switched off, a call stops honestly: no rules stand-in, outcome ai_failed or not started", Boolean(fail) && (fail.outcome === "ai_failed" || /couldn.?t|could not|AI|model/i.test(fail.place)) && !/paid|link/i.test(fail.outcome ?? ""), fail ? `armed: ${armed.split("ok=")[1]?.slice(0, 60) ?? armed.slice(0, 60)}; call ${fail.status}, outcome ${fail.outcome ?? "none"}; ${fail.place.includes("err=") ? `place said: ${fail.place.split("err=")[1].slice(0, 110)}` : `last line: ${fail.last.slice(0, 110)}`}` : "no planned call for Marcus");
const sc = (await req("POST", "/safety/scan", { text: "Hi! Just a reminder your Pilates class is on Thursday at 6pm. See you there." }, "json")).json;
record("A11", "with the AI switched off, the scam check says its AI reader did not run and never shows green", sc?.readers?.decisions?.level === "not_run" && sc?.all_clear_allowed === false, `AI reader ${sc?.readers?.decisions?.level} (${sc?.readers?.decisions?.why_not_run}); all clear allowed ${sc?.all_clear_allowed}; ${sc?.summary ?? ""}`);
const ak = await req("POST", "/api/app/ask", { question: "Who owes money today?" }, "json");
let ar = null;
for (let i = 0; i < 20 && ak.json?.run_id; i++) { await sleep(2000); ar = (await get(`/api/app/ask/${ak.json.run_id}`)).json; if (ar?.run?.status && ar.run.status !== "running") break; }
const aerr = (ar?.steps ?? []).find((x) => /error|fail/.test(x.tool ?? ""))?.result;
record("A11", "with the AI switched off, Ask says it could not answer (no made-up answer)", ak.status >= 500 || ar?.run?.status === "failed", `POST ${ak.status}${ak.json?.error ? ` (${String(ak.json.error).slice(0, 80)})` : ""}; run ${ar?.run?.status ?? "none"}${aerr ? `; ${JSON.stringify(aerr).slice(0, 100)}` : ""}`);
const off = decodeURIComponent(String((await post("/demo/fault-ai", { off: "1" })).location ?? ""));
const sc2 = (await req("POST", "/safety/scan", { text: "Hi! Just a reminder your Pilates class is on Thursday at 6pm. See you there." }, "json")).json;
record("A11", "switched back on, the AI reader runs again", sc2?.readers?.decisions?.level !== "not_run", `${off.split("ok=")[1] ?? off}; AI reader ${sc2?.readers?.decisions?.level}`);

console.log("| Item | Check | Result | Detail |\n|---|---|---|---|");
for (const r of rows) console.log(`| ${r.item} | ${r.check} | ${r.ok ? "Pass" : "Fail"} | ${String(r.detail).replace(/\|/g, "\\|")} |`);
console.log(`\nRun ${new Date().toISOString()} against ${BASE} (commit ${commit}).`);
process.exit(rows.every((r) => r.ok) ? 0 : 1);
