/** Demo controls: reset and seed, pin the business clock, arm PayPal faults, run a persona through a planned call. */
import { Router } from "express";
import { config } from "../config.js";
import { getDb, SCHEMA } from "../db.js";
import { personas } from "../eval/personas.js";
import { armFault, FAULTABLE, paypalConfigured } from "../paypal/index.js";
import { customerSays, startCall } from "../services/calls.js";
import { planCalls } from "../services/planner.js";
import { seedDemo } from "../services/seed.js";
import { bizById, callsOf, customersOf, firstBiz } from "../store.js";
import { me, personByKey, signIn } from "./auth.js";
import { back, flashOf, page } from "./common.js";
import { html, layout, pill } from "./html.js";
import { ownerPage } from "./views.js";

const TABLES = ["voice_events", "callbacks", "pay_links", "invoices", "instalment_plans", "refunds", "calls", "obligations", "policies", "call_history", "customers", "people", "events", "demo_faults", "webhook_events", "jobs_queue", "ai_calls", "agent_trace", "agent_runs", "audit_chain", "kill_switches", "approvals", "passkeys", "provenance", "channel_messages", "party_links", "push_subscriptions", "judge_sessions", "eval_runs", "guard_settings", "businesses"];

export async function resetAndSeed(opts: { now?: Date; pinClock?: boolean } = {}) {
  const db = await getDb();
  for (const t of TABLES) await db.query(`DELETE FROM ${t}`);
  await db.exec(SCHEMA);
  return seedDemo(db, opts);
}

export function demoRouter(): Router {
  const r = Router();
  r.get("/demo", page(async (req, res) => {
    const db = await getDb();
    const p = await me(req);
    const biz = p ? await bizById(db, p.business_id) : await firstBiz(db);
    const keysRow = p?.role === "owner" && config.demoMode ? (await db.query<{ value: string }>("SELECT value FROM settings WHERE key = 'demo_keys'")).rows[0] : null;
    const keys = keysRow ? (JSON.parse(keysRow.value) as { owner: string; staff: string }) : null;
    const calls = biz ? await callsOf(db, biz.id, { status: ["planned", "blocked"], limit: 50 }) : [];
    const custs = biz ? new Map((await customersOf(db, biz.id)).map((c) => [c.id, c])) : new Map();
    const body = html`<h1>Demo controls</h1><p class="muted">${config.demoMode ? "Demo mode is on." : "Demo mode is off: faults cannot be armed."} PayPal: ${paypalConfigured() ? pill("paid", "sandbox configured") : pill("warn", "not configured: pages work, money moves fail honestly")}.</p>
${!p && config.demoMode && biz ? html`<div class="card"><h3>Sign in</h3><p class="small muted">Demo mode: sign in as the seeded owner or staff member without a key.</p><form method="post" action="/demo/signin-as" class="row"><button class="btn primary" name="role" value="owner" type="submit">Sign in as the owner</button><button class="btn" name="role" value="staff" type="submit">Sign in as staff</button></form></div>` : ""}
${keys ? html`<div class="banner good"><b>Access keys (owner only; for MCP clients).</b> Owner key <code>${keys.owner}</code> · staff key <code>${keys.staff}</code>. <form method="post" action="/demo/signin" class="inline"><input type="hidden" name="key" value="${keys.owner}"><button class="btn primary small" type="submit">Sign in as owner</button></form></div>` : ""}
<div class="grid2"><div class="card"><h3>Data</h3><form method="post" action="/demo/reset" class="stack"><label><input type="checkbox" name="pin" value="1" checked> Pin the business clock to a Wednesday 13:00 Sydney so calling hours are reproducible</label><button class="btn primary" type="submit">Reset and seed</button></form>
${biz ? html`<form method="post" action="/demo/clock" class="stack"><label>Business clock (ISO, blank = real time)<input name="now" value="${biz.sim_now ?? ""}" placeholder="2026-03-04T02:00:00Z"></label><div class="callbar"><button class="btn" type="submit">Set clock</button><button class="btn" type="submit" name="now" value="2026-03-04T11:00:00Z">22:00 Sydney (outside hours)</button><button class="btn" type="submit" name="now" value="2026-03-07T02:00:00Z">Saturday</button><button class="btn" type="submit" name="now" value="2026-03-04T02:00:00Z">Wed 13:00</button></div></form><form method="post" action="/demo/plan"><button class="btn" type="submit">Re-plan calls now</button></form>` : ""}</div>
<div class="card"><h3>PayPal faults</h3><p class="small muted">Arm a failure for the next call of a method; the agent must stay honest ("nothing has been charged").</p><form method="post" action="/demo/fault" class="callbar"><select name="method">${FAULTABLE.map((m) => html`<option>${m}</option>`)}</select><select name="kind"><option value="fail_503">503 unavailable</option><option value="lose_response">lose the response</option></select><button class="btn" type="submit">Arm</button></form></div></div>
${biz && p ? html`<div class="card"><h3>Run a scripted customer</h3><p class="small muted">Starts the chosen planned call in the simulator and plays a persona's lines through it, one turn at a time, with the real gate.</p><form method="post" action="/demo/persona" class="callbar"><select name="call">${calls.map((c) => html`<option value="${c.id}">${custs.get(c.customer_id)?.name}: ${c.purpose.replace(/_/g, " ")} (${c.status})</option>`)}</select><select name="persona">${personas().map((x) => html`<option value="${x.id}">${x.id}</option>`)}</select><button class="btn primary" type="submit" ${calls.length ? "" : "disabled"}>Run</button></form></div>` : html`<p class="muted">Sign in to run personas.</p>`}
<div class="card"><h3>Judge tour</h3><p>The <a href="/judge">judge page</a> walks the five beats in under five minutes without signing in: the plan and what is refused, a call with a haggler, a hold and the owner's approval, the policy backtest, and the evidence page.</p></div>`;
    res.send(p ? await ownerPage(req, p, "Demo", body) : layout({ title: "Demo", flash: flashOf(req) }, body));
  }));
  r.post("/demo/reset", page(async (req, res) => {
    const who = await me(req);
    const db0 = await getDb();
    const anyBiz = await firstBiz(db0);
    // Reset wipes every table, so it needs the owner. An empty database (first deploy) may be seeded by anyone once.
    if (anyBiz && (!who || who.role !== "owner")) return back(res, "/demo", "Only the signed-in owner can reset the demo data. Use \"Sign in as the owner\" first.", true);
    const seeded = await resetAndSeed({ now: req.body.pin === "1" ? new Date("2026-03-04T02:00:00Z") : new Date(), pinClock: req.body.pin === "1" });
    const db = await getDb();
    await planCalls(db, seeded.business.id, "demo");
    // The new keys are kept for the owner's eyes on this page (demo mode only; MCP clients need them), never in a URL.
    if (config.demoMode) await db.query("INSERT INTO settings (key, value) VALUES ('demo_keys', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify({ owner: seeded.ownerKey, staff: seeded.staffKey })]);
    const owner = await personByKey(seeded.ownerKey);
    if (owner) signIn(res, owner, req.secure);
    res.redirect(`/demo?ok=${encodeURIComponent("Seeded and planned. You are signed in as the owner.")}`);
  }));
  /** Demo mode only: a judge signs in as the seeded owner or staff member without seeing a key. */
  r.post("/demo/signin-as", page(async (req, res) => {
    if (!config.demoMode) return back(res, "/demo", "Demo mode is off.", true);
    const db = await getDb();
    const biz = await firstBiz(db);
    const role = req.body.role === "staff" ? "staff" : "owner";
    const row = biz ? (await db.query<any>("SELECT * FROM people WHERE business_id = $1 AND role = $2 ORDER BY name LIMIT 1", [biz.id, role])).rows[0] : null;
    if (!row) return back(res, "/demo", "Seed the demo first.", true);
    signIn(res, row, req.secure);
    res.redirect(role === "owner" ? "/today" : "/calls");
  }));
  r.post("/demo/signin", page(async (req, res) => {
    const p = await personByKey(String(req.body.key ?? ""));
    if (!p) return back(res, "/demo", "Key not recognised.", true);
    signIn(res, p, req.secure);
    res.redirect("/today");
  }));
  r.post("/demo/clock", page(async (req, res) => {
    const db = await getDb();
    const p = await me(req);
    const biz = p ? await bizById(db, p.business_id) : await firstBiz(db);
    if (!biz) return back(res, "/demo", "Seed first.", true);
    const v = String(req.body.now ?? "").trim();
    await db.query("UPDATE businesses SET sim_now = $2 WHERE id = $1", [biz.id, v ? new Date(v).toISOString() : null]);
    await planCalls(db, biz.id, "demo");
    back(res, "/demo", v ? `Clock pinned to ${v}; calls re-planned.` : "Clock back to real time.");
  }));
  r.post("/demo/plan", page(async (req, res) => {
    const db = await getDb();
    const p = await me(req);
    const biz = p ? await bizById(db, p.business_id) : await firstBiz(db);
    if (!biz) return back(res, "/demo", "Seed first.", true);
    const out = await planCalls(db, biz.id, "demo");
    back(res, "/demo", `Planned ${out.planned}, blocked ${out.blocked}.`);
  }));
  r.post("/demo/fault", page(async (req, res) => {
    if (!config.demoMode) return back(res, "/demo", "Demo mode is off.", true);
    const method = String(req.body.method);
    if (!(FAULTABLE as readonly string[]).includes(method)) return back(res, "/demo", "Unknown method.", true);
    await armFault(method, req.body.kind === "lose_response" ? "lose_response" : "fail_503");
    back(res, "/demo", `Armed ${req.body.kind} on ${method}.`);
  }));
  r.post("/demo/persona", page(async (req, res) => {
    const p = await me(req);
    if (!p) return res.redirect("/login");
    const db = await getDb();
    const persona = personas().find((x) => x.id === String(req.body.persona));
    if (!persona) return back(res, "/demo", "Unknown persona.", true);
    const callId = String(req.body.call);
    try {
      await startCall(db, callId, "simulator", p.name, { persona: persona.id });
      for (const line of persona.lines) {
        const out = await customerSays(db, callId, line, "demo");
        if (out.ended) break;
      }
      res.redirect(`/calls/${callId}?ok=${encodeURIComponent(`Persona ${persona.id} played.`)}`);
    } catch (e) {
      back(res, `/calls/${callId}`, (e as Error).message, true);
    }
  }));
  return r;
}
