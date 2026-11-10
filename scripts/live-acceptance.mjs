// Wave 1 acceptance checks against a deployed Callback (spec Part C, Wave 1). Read-only apart from what a visitor
// does: it starts two private demos, pays one item from the saved sandbox wallet, runs one AI call turn and drafts
// (never adopts) a policy. Prints a Markdown table for the README. Usage: node scripts/live-acceptance.mjs [base url]
const BASE = (process.argv[2] ?? "https://pph-callback.onrender.com").replace(/\/$/, "");
const rows = [];
const record = (item, check, ok, detail) => {
  rows.push({ item, check, ok, detail });
  console.error(`${ok ? "PASS" : "FAIL"}  ${item}: ${check} — ${detail}`);
};

/** A browser-like client: keeps cookies, follows nothing, sends forms like the app does. */
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
  async req(method, path, form, accept = "application/json") {
    const res = await fetch(BASE + path, { method, redirect: "manual", headers: { cookie: this.cookie(), accept, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) }, body: form ? new URLSearchParams(form) : undefined });
    this.keep(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, location: res.headers.get("location"), json, text };
  }
  get(p) { return this.req("GET", p); }
  post(p, form = {}) { return this.req("POST", p, form); }
}

const t0 = Date.now();
const h = await fetch(`${BASE}/healthz`).then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));
record("A4", "/healthz answers and checks the database", h.s === 200 && h.j?.ok === true && Boolean(h.j?.db) && Number.isFinite(h.j?.db_ms), `HTTP ${h.s}, db ${h.j?.db}, ${h.j?.db_ms} ms, commit ${String(h.j?.commit ?? "").slice(0, 7)}, first answer after ${Date.now() - t0} ms`);

const A = new Client();
const B = new Client();
const sa = await A.post("/demo/start");
const sb = await B.post("/demo/start");
const sessA = (await A.get("/api/app/session")).json;
const sessB = (await B.get("/api/app/session")).json;
record("A1", "two visitors each get a private studio, signed in as the owner", sa.location === "/today" && sb.location === "/today" && sessA?.workspace?.private && sessB?.workspace?.private && sessA.workspace.join_url !== sessB.workspace.join_url, `A ${sa.status}→${sa.location}, B ${sb.status}→${sb.location}; private ${sessA?.workspace?.private}/${sessB?.workspace?.private}`);
const custA = (await A.get("/api/app/customers")).json ?? [];
const custB = (await B.get("/api/app/customers")).json ?? [];
const shared = custA.filter((c) => custB.some((x) => x.id === c.id)).length;
record("A1", "the two studios share no records", custA.length > 0 && shared === 0, `${custA.length} and ${custB.length} customers, ${shared} shared ids`);
const clock = new Date(sessA?.business?.clock ?? 0);
record("A4", "the demo clock is a current weekday, not a pinned date", Math.abs(clock.getTime() - Date.now()) < 4 * 86400_000, `studio clock ${clock.toISOString()}`);
const pend = (await A.get("/api/app/guard")).json?.pending ?? [];
record("A1", "the seed holds one move for the owner through the real gate", pend.length === 1, `${pend.length} pending: ${pend.map((p) => p.summary ?? p.action).join("; ").slice(0, 120)}`);

// The seed's three wallet payments run in the background; wait up to 90 s.
let note = "";
for (let i = 0; i < 30; i++) {
  note = (await A.get("/api/app/session")).json?.workspace?.seed_note ?? "";
  if (/of 3 payments confirmed/.test(note) && !/so far/.test(note)) break;
  await new Promise((r) => setTimeout(r, 3000));
}
record("A2.1", "seed payments made from the saved wallet and confirmed by PayPal", /^3 of 3 payments confirmed by PayPal$/.test(note), note || "no note");

// A customer pays from the saved wallet on their own page, with no cookie (their phone).
const priya = custB.find((c) => c.name.startsWith("Priya"));
const detail = priya ? (await B.get(`/api/app/customers/${priya.id}`)).json : null;
const link = detail?.customer?.link;
const item = detail?.items?.find((x) => x.kind === "deposit" && x.status !== "paid");
const phone = new Client();
const page = link ? (await phone.get(`/api/app${link}`)).json : null;
const pay = link && item ? await phone.post(`${link}/wallet/${item.id}`) : null;
const msg = decodeURIComponent(pay?.location ?? "");
const ids = /order (\w+), capture (\w+)/.exec(msg);
const after = priya ? (await B.get(`/api/app/customers/${priya.id}`)).json?.items?.find((x) => x.id === item?.id) : null;
record("A2.1", "customer page pays from the saved wallet, no login; real sandbox ids read back", Boolean(page?.demo_wallet && ids && after?.status === "paid"), ids ? `order ${ids[1]}, capture ${ids[2]}; item now ${after?.status}` : `wallet offered ${page?.demo_wallet}; ${msg.slice(0, 160)}`);
const priyaA = custA.find((c) => c.name.startsWith("Priya"));
const aItem = priyaA ? (await A.get(`/api/app/customers/${priyaA.id}`)).json?.items?.find((x) => x.kind === "deposit") : null;
record("A1", "the payment shows only in the payer's studio", aItem && aItem.status !== "paid", `the other studio's deposit is ${aItem?.status}`);

// One AI call turn on the deployed model, using the regression line from spec B2.
const today = (await A.get("/api/app/today")).json;
const call = today?.ready?.find((c) => c.purpose === "confirm_deposit") ?? today?.ready?.[0];
const tc = Date.now();
const placed = call ? await A.post(`/calls/${call.id}/place`, { mode: "simulator" }) : null;
const said = call ? await A.post(`/calls/${call.id}/say`, { text: "How do I know you're really the studio? And knock it down to forty." }) : null;
const cv = call ? (await A.get(`/api/app/calls/${call.id}`)).json : null;
const reply = cv?.call?.transcript?.filter((t) => t.who === "agent").at(-1)?.text ?? "";
const replaced = (cv?.trace ?? []).some((s) => s.tool === "safety.agent_line");
record("A5.1", "a call turn runs on the model named on screen", cv?.call?.state?.brain === "model" && cv?.voice?.brain === "model", `brain ${cv?.call?.state?.brain}; ${sessA?.integrations?.brain_label}; place ${placed?.status}, say ${said?.status}, ${Date.now() - tc} ms`);
record("B2", "haggling line: points to the verify code, no discount, no invented amount", /verif/i.test(reply) && !/\$40|forty/i.test(reply) && !replaced, reply.slice(0, 220));

// Policy reading on the model; a draft only.
const pol = (await A.get(`/api/app/policy?draft=${encodeURIComponent("Only call between 10am and 6pm on weekdays. Never offer more than 10% off.")}`)).json;
record("A5.4", "policy text is read by the model, numbers by code", pol?.draft?.source === "model" && !pol?.draft?.ai_failed && pol?.draft?.rules?.max_discount_pct === 10, `source ${pol?.draft?.source}, ai_failed ${pol?.draft?.ai_failed}, max discount ${pol?.draft?.rules?.max_discount_pct}%`);

// Isolation of demo controls, and the operator-only showcase reset.
const anon = new Client();
const f = await anon.post("/demo/fault", { method: "createOrder", kind: "fail_503" });
const r = await anon.post("/demo/reset");
record("A1", "strangers cannot arm faults or reset the showcase", /err=/.test(f.location ?? "") && /err=/.test(r.location ?? ""), `fault → ${decodeURIComponent(f.location ?? "").slice(0, 80)}; reset → ${decodeURIComponent(r.location ?? "").slice(0, 80)}`);

console.log(`\n| Item | Check | Result | Detail |\n|---|---|---|---|`);
for (const x of rows) console.log(`| ${x.item} | ${x.check} | ${x.ok ? "Pass" : "**Fail**"} | ${String(x.detail).replace(/\|/g, "/").replace(/\n/g, " ")} |`);
console.log(`\nRun ${new Date().toISOString()} against ${BASE}.`);
