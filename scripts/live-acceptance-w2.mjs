// Wave 2 acceptance checks against a deployed Callback (spec Part C, Wave 2: items 6 to 9). It does what a visitor
// does: starts one private demo, walks the judge page's first path (a simulated call, two AI turns, one real sandbox
// order, one payment from the saved sandbox wallet), checks three messages, asks the agent two questions and reads
// the public pages. Prints a Markdown table for the README. Usage: node scripts/live-acceptance-w2.mjs [base url]
const BASE = (process.argv[2] ?? "https://pph-callback.onrender.com").replace(/\/$/, "");
const rows = [];
const record = (item, check, ok, detail) => {
  rows.push({ item, check, ok, detail });
  console.error(`${ok ? "PASS" : "FAIL"}  ${item}: ${check} — ${detail}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor() { this.jar = new Map(); }
  cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  keep(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      this.jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
  }
  async req(method, path, body, kind = "form", accept = "application/json") {
    const headers = { cookie: this.cookie(), accept };
    if (body && kind === "form") headers["content-type"] = "application/x-www-form-urlencoded";
    if (body && kind === "json") headers["content-type"] = "application/json";
    const res = await fetch(BASE + path, { method, redirect: "manual", headers, body: body ? (kind === "json" ? JSON.stringify(body) : new URLSearchParams(body)) : undefined });
    this.keep(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, location: res.headers.get("location"), json, text };
  }
  get(p, accept) { return this.req("GET", p, undefined, "form", accept); }
  post(p, form = {}) { return this.req("POST", p, form); }
  postJson(p, body) { return this.req("POST", p, body, "json"); }
}

const NOV10 = "Hi, hope you're well. Just a heads up that we've moved banks, so please send this month's payment to our new PayPal: accounts.brightside@outlook.com. Thanks so much!";
const NAMES_PLACE = "Thanks for booking with Brightside Physio. You can pay this week's session at paypal.me/brightsidepilates whenever suits.";
const GENUINE = "Hi! Just a reminder your Pilates class is on Thursday at 6pm. See you there.";

const h = await fetch(`${BASE}/healthz`).then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));
const commit = String(h.j?.commit ?? "").slice(0, 7);
record("A4", "/healthz answers and names the deployed commit", h.s === 200 && h.j?.ok === true, `HTTP ${h.s}, commit ${commit}`);

// The judge page, before and after a demo exists.
const J = new Client();
const anon = (await J.get("/api/public/judge")).json;
record("A3.1", "a stranger sees three paths, the live-versus-simulated table and the public pages", anon?.paths?.length === 3 && anon.live.length >= 10 && anon.pages.length === 6 && anon.workspace === null, `${anon?.paths?.map((p) => `${p.title} (${p.steps.length} steps, ${p.minutes} min)`).join("; ")}; ${anon?.live?.filter((r) => r.live).length} live rows, ${anon?.live?.filter((r) => !r.live).length} simulated`);
const t0 = Date.now();
const first = await J.post("/demo/signin-as", { role: "owner" });
let j = (await J.get("/api/public/judge")).json;
const tapped = `first tap → HTTP ${first.status} ${decodeURIComponent(String(first.location ?? first.json?.message ?? "")).slice(0, 140)}`;
record("A3.1", "after the first tap: a QR code for the phone and every step points at this demo's own screens", /^<svg/.test(j?.workspace?.qr_svg ?? "") && j.paths.flatMap((p) => p.steps).every((s) => s.href), `join link ${j?.workspace?.join_url ? "present" : "missing"}; ${j?.paths?.flatMap((p) => p.steps).filter((s) => s.href).length} of ${j?.paths?.flatMap((p) => p.steps).length} steps have a screen; ${tapped}`);
if (!j?.workspace) {
  // No private demo, so there is nothing to walk: say why and stop, rather than crash on a missing screen.
  console.log(`| Item | Check | Result | Detail |\n|---|---|---|---|\n${rows.map((r) => `| ${r.item} | ${r.check} | ${r.ok ? "Pass" : "**Fail**"} | ${String(r.detail).replace(/\|/g, "/")} |`).join("\n")}\n\nStopped: no private demo was started (${tapped}).`);
  process.exit(1);
}
const seedTicks = Object.keys(j.checklist);
record("A3.1", "nothing is ticked before the visitor acts (the seed ticks nothing)", seedTicks.length === 0, seedTicks.length ? seedTicks.join(", ") : "0 ticks");

// Path 1: take the call yourself, as the buttons do (the call page posts to these routes).
const [take, refuse, approve] = j.paths;
const call = take.steps[0].href;
const place = await J.post(`${call}/place`, { mode: "simulator" });
const say1 = await J.post(`${call}/say`, { text: decodeURIComponent(take.steps[1].href.split("say=")[1]) });
const say2 = await J.post(`${call}/say`, { text: decodeURIComponent(take.steps[2].href.split("say=")[1]) });
const detail = (await J.get(`/api/app${call}`)).json;
const turns = (detail?.call?.transcript ?? []).filter((t) => t.who !== "customer").map((t) => t.text);
const portal = take.steps[3].href;
const pdata = (await J.get(`/api/app${portal}`)).json;
const dep = (pdata?.open ?? pdata?.items ?? []).find?.((o) => o.kind === "deposit") ?? null;
const pay = dep ? await J.post(`${portal}/wallet/${dep.id}`) : { location: "no open deposit" };
const secs = Math.round((Date.now() - t0) / 1000);
j = (await J.get("/api/public/judge")).json;
const ticked1 = take.steps.filter((s) => j.checklist[s.key]).map((s) => s.key);
record("A3.1", "path 1 (take the call yourself, no PayPal login): every step ticked itself", ticked1.length === take.steps.length, `${ticked1.length}/${take.steps.length} ticked (${ticked1.join(", ")}); place ${place.status}, say ${say1.status}/${say2.status}, wallet → ${String(pay.location ?? "").slice(0, 90)}; ${secs} s by script`);
record("B2", "the haggling turn: no invented discount, the agreed turn: a real sandbox order", turns.length >= 3 && !/\$\d+ off|\d+% off/i.test(turns[1] ?? "") && Boolean(detail?.item?.paypal_order_id), `agent said: "${(turns[1] ?? "").slice(0, 140)}" then "${(turns[2] ?? "").slice(0, 100)}"; PayPal order ${detail?.item?.paypal_order_id ?? "none"}`);

// Path 2: watch it refuse.
const blocked = refuse.steps[1].href;
await J.get(`/api/app${blocked}`);
const scan = async (text) => (await J.postJson("/safety/scan", { text })).json;
const s1 = await scan(NOV10);
record("A6", "the 10 Nov message is held by every server reader, with the place to pay named", s1?.level === "hold" && s1.readers.rules.level === "hold" && s1.readers.decisions.level === "hold" && s1.readers.code.level === "hold" && !s1.all_clear_allowed, `level ${s1?.level}; rules ${s1?.readers?.rules?.level}, AI ${s1?.readers?.decisions?.level} (${s1?.readers?.decisions?.model}, ${s1?.readers?.decisions?.ms} ms), places to pay ${s1?.readers?.code?.level}: ${s1?.readers?.code?.destinations?.map((d) => d.value).join(", ")}`);
const s2 = await scan(NAMES_PLACE);
record("A6", "a polite message that names a place to pay never gets green", s2 && !s2.all_clear_allowed && s2.names_destination, `level ${s2?.level}, names a place ${s2?.names_destination}, all clear allowed ${s2?.all_clear_allowed}`);
const s3 = await scan(GENUINE);
record("A6", "a genuine reminder: every server reader ran and found nothing", s3?.all_clear_allowed === true, `level ${s3?.level}, AI ${s3?.readers?.decisions?.level}, all clear allowed ${s3?.all_clear_allowed}`);
const cust = (await new Client().postJson(`${portal}/check`, { text: NOV10 })).json;
record("A6", "the customer's own page holds it too (no sign-in)", cust?.level === "hold" && !cust.all_clear_allowed, `level ${cust?.level}`);

async function ask(question) {
  const r = await J.postJson("/api/app/ask", { question });
  const id = r.json?.run_id;
  let st = null;
  for (let i = 0; i < 40 && id; i++) {
    await sleep(2000);
    st = (await J.get(`/api/app/ask/${id}`)).json;
    if (st?.run?.status && st.run.status !== "running") break;
  }
  const tools = (st?.steps ?? []).filter((s) => s.tool === "ask.tool").map((s) => ({ name: s.result.name, source: s.result.source, ok: s.result.ok }));
  const ans = (st?.steps ?? []).find((s) => s.tool === "ask.answer")?.result;
  return { status: r.status, run: st?.run?.status, tools, ans, ms: st?.steps?.length ? new Date(st.steps.at(-1).at) - new Date(st.steps[0].at) : null };
}
const a1 = await ask(decodeURIComponent(refuse.steps[0].href.split("q=")[1]));
record("A5.3", "the judge's Ask question: the rail shows at least two tool calls and a cited answer", a1.run === "done" && a1.tools.length >= 2 && (a1.ans?.sentences ?? []).some((s) => s.cites?.length), `${a1.tools.length} tool calls (${a1.tools.map((t) => t.name).join(", ")}); ${(a1.ans?.sentences ?? []).filter((s) => s.text).length} sentences, ${a1.ans?.removed ?? 0} removed by code; ${Math.round((a1.ms ?? 0) / 1000)} s`);
const a2 = await ask("Has PayPal confirmed the payments from yesterday's calls?");
const ppTools = a2.tools.filter((t) => t.source === "paypal");
record("A5.3", "a PayPal question goes through PayPal's MCP server, read tools only", a2.run === "done" && ppTools.length >= 1 && ppTools.every((t) => /^paypal_(get|list|show)_/.test(t.name)), `${a2.tools.length} tool calls, ${ppTools.length} on PayPal's server (${ppTools.map((t) => `${t.name}${t.ok ? "" : " failed"}`).join(", ")})`);

// Path 3: approve a held move.
const guard = (await J.get("/api/app/guard")).json;
const held = guard?.pending?.[0];
const dec = held ? await J.post(`/ops/guard/approvals/${held.id}/approve`) : { location: "nothing held" };
await J.get("/api/app/money");
j = (await J.get("/api/public/judge")).json;
const all = j.paths.map((p) => `${p.title}: ${p.steps.filter((s) => j.checklist[s.key]).length}/${p.steps.length}`);
record("A3.1", "paths 2 and 3 ticked themselves too", j.paths.every((p) => p.steps.every((s) => j.checklist[s.key])), `${all.join("; ")}; approve → ${String(dec.location ?? "").slice(0, 80)}`);

// The no-sign-in pages.
const S = new Client();
const proof = (await S.get("/api/public/proof")).json;
const today = new Date().toISOString().slice(0, 10);
const cases = proof?.eval?.jobs?.reduce((n, x) => n + x.cases.length, 0) ?? 0;
record("A5.6", "/proof lists every case with today's run date and the model ids", proof?.eval?.run_at?.slice(0, 10) === today && cases > 0 && proof.eval.jobs.every((x) => x.cases.every((c) => "input" in c && "expected" in c && "answer" in c && "pass" in c)), `run ${proof?.eval?.run_at}; ${proof?.eval?.jobs?.map((x) => `${x.job} ${x.passed}/${x.total} on ${x.model}`).join("; ")}; ${proof?.eval?.not_measured?.length} not-measured notes`);
const pp = (await S.get("/api/public/paypal")).json;
record("A3.2", "/paypal: each API with a live sandbox id where one exists", pp?.apis?.length === 8, pp?.apis?.map((a) => `${a.api.split(":")[0].split(" (")[0]}: ${a.live ? a.live.id : "none yet"}`).join("; "));
const ai = (await S.get("/api/public/ai")).json;
record("A3.2", "/ai: the last model calls with model, latency and cost", Array.isArray(ai?.showcase), `${ai?.showcase?.length} showcase calls listed`);
const facts = (await S.get("/api/public/facts")).json;
record("A3.2", "/who-can-move-money: limits read from the studio's settings", facts?.limits?.auto_charge_max_cents > 0 && facts.roles.length >= 7, `charge ${facts?.limits?.auto_charge_max_cents / 100}, refund ${facts?.limits?.auto_refund_max_cents / 100}, countersign ${facts?.limits?.countersign_above_cents / 100}; ${facts?.roles?.length} roles`);
const pages = [];
for (const p of ["/judge", "/proof", "/ai", "/paypal", "/who-can-move-money", "/accessibility", "/agents"]) pages.push(`${p} ${(await S.get(p, "text/html")).status}`);
record("A3.2", "every no-sign-in page loads without a session", pages.every((x) => x.endsWith(" 200")), pages.join(", "));

console.log(`| Item | Check | Result | Detail |\n|---|---|---|---|\n${rows.map((r) => `| ${r.item} | ${r.check} | ${r.ok ? "Pass" : "**Fail**"} | ${String(r.detail).replace(/\|/g, "/").replace(/\n/g, " ")} |`).join("\n")}\n\nRun ${new Date().toISOString()} against ${BASE} (commit ${commit}).`);
process.exit(rows.every((r) => r.ok) ? 0 : 1);
