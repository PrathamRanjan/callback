/** Demo controls: reset and seed, pin the business clock, arm PayPal faults, run a persona through a planned call. */
import { Router } from "express";
import { config } from "../config.js";
import { APP_TABLES, currentWs, getDb, inWorkspace, SCHEMA } from "../db.js";
import { personas } from "../eval/personas.js";
import { armFault, FAULTABLE, paypalConfigured } from "../paypal/index.js";
import { AI_FAULT_MINUTES, armAiFault, disarmAiFault } from "../ai/provider.js";
import { customerSays, startCall } from "../services/calls.js";
import { planCalls } from "../services/planner.js";
import { seedDemo } from "../services/seed.js";
import { bizById, callsOf, customersOf, firstBiz } from "../store.js";
import { demoClock, rebuildShowcase, resetWorkspace, startWorkspace, workspaceByJoinToken, type Workspace } from "../services/workspaces.js";
import { GtError } from "../lib/util.js";
import { setWorkspaceCookie, workspaceOf } from "./workspace.js";
import type { Request, Response } from "express";
import { me, personByKey, signIn } from "./auth.js";
import { back, clientIp, flashOf, page } from "./common.js";
import { html, layout, pill } from "./html.js";
import { ownerPage } from "./views.js";

const TABLES = APP_TABLES;

/** The operator key (CB_ADMIN_KEY) in a header or the form; without the setting, admin actions are closed. */
export function isAdmin(req: Request): boolean {
  const k = String(req.get("x-admin-key") ?? req.body?.admin_key ?? "");
  return Boolean(config.adminKey) && k === config.adminKey;
}

/** Signs the visitor in as the workspace's owner or front-desk person (inside that workspace). */
async function signInWorkspace(res: Response, req: Request, w: Workspace, role: "owner" | "staff") {
  setWorkspaceCookie(res, w.id, req.secure);
  await inWorkspace(w.id, async () => {
    const db = await getDb();
    const row = (await db.query<any>("SELECT * FROM people WHERE role = $1 ORDER BY name LIMIT 1", [role])).rows[0];
    if (!row) throw new GtError("This demo has no one to sign in as yet. Reset it.", "not_seeded", 409);
    signIn(res, row, req.secure);
  });
}

/** The visitor's workspace, or a new one (rate limited) when they have none. */
async function ensureWorkspace(req: Request): Promise<{ w: Workspace; created: boolean }> {
  const have = workspaceOf(req);
  if (have) return { w: have, created: false };
  return { w: await startWorkspace({ ip: clientIp(req) }), created: true };
}

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
<div class="grid2"><div class="card"><h3>Data</h3><form method="post" action="/demo/reset" class="stack"><p class="small muted">Rebuilds your demo from scratch on a weekday-morning studio clock. Only your demo changes.</p><button class="btn primary" type="submit">Reset my demo</button></form>
${biz ? html`<form method="post" action="/demo/clock" class="stack"><label>Studio clock (ISO, blank = real time)<input name="now" value="${biz.sim_now ?? ""}"></label><div class="callbar"><button class="btn" type="submit">Set clock</button><button class="btn" type="submit" name="days" value="1">+1 day</button><button class="btn" type="submit" name="morning" value="1">Back to a weekday morning</button></div></form><form method="post" action="/demo/plan"><button class="btn" type="submit">Re-plan calls now</button></form>` : ""}</div>
<div class="card"><h3>PayPal faults</h3><p class="small muted">Arm a failure for the next call of a method; the agent must stay honest ("nothing has been charged").</p><form method="post" action="/demo/fault" class="callbar"><select name="method">${FAULTABLE.map((m) => html`<option>${m}</option>`)}</select><select name="kind"><option value="fail_503">503 unavailable</option><option value="lose_response">lose the response</option></select><button class="btn" type="submit">Arm</button></form></div></div>
${biz && p ? html`<div class="card"><h3>Run a scripted customer</h3><p class="small muted">Starts the chosen planned call in the simulator and plays a persona's lines through it, one turn at a time, with the real gate.</p><form method="post" action="/demo/persona" class="callbar"><select name="call">${calls.map((c) => html`<option value="${c.id}">${custs.get(c.customer_id)?.name}: ${c.purpose.replace(/_/g, " ")} (${c.status})</option>`)}</select><select name="persona">${personas().map((x) => html`<option value="${x.id}">${x.id}</option>`)}</select><button class="btn primary" type="submit" ${calls.length ? "" : "disabled"}>Run</button></form></div>` : html`<p class="muted">Sign in to run personas.</p>`}
<div class="card"><h3>Judge tour</h3><p>The <a href="/judge">judge page</a> walks the five beats in under five minutes without signing in: the plan and what is refused, a call with a haggler, a hold and the owner's approval, the policy backtest, and the evidence page.</p></div>`;
    res.send(p ? await ownerPage(req, p, "Demo", body) : layout({ title: "Demo", flash: flashOf(req) }, body));
  }));
  /** One tap: a private, populated workspace for this visitor (spec A1.2). `fresh=1` always makes a new one. */
  r.post("/demo/start", page(async (req, res) => {
    if (!config.demoMode || !config.workspaces.enabled) return back(res, "/try", "Private demos are off on this server.", true);
    const role = req.body.role === "staff" ? "staff" : "owner";
    const w = req.body.fresh === "1" || !workspaceOf(req) ? await startWorkspace({ ip: clientIp(req) }) : workspaceOf(req)!;
    await signInWorkspace(res, req, w, role);
    res.redirect(role === "owner" ? "/today" : "/calls");
  }));
  /** Opens the visitor's own workspace on a second device (the QR code on the judge page). */
  r.get("/demo/join/:token", page(async (req, res) => {
    const w = await workspaceByJoinToken(String(req.params.token));
    if (!w) return res.redirect(`/try?err=${encodeURIComponent("That demo link has expired. Start a new demo here.")}`);
    await signInWorkspace(res, req, w, "owner");
    res.redirect("/today");
  }));
  r.post("/demo/reset", page(async (req, res) => {
    const who = await me(req);
    const w = workspaceOf(req);
    if (w) {
      // "Reset my demo": only this visitor's workspace is rebuilt, nobody else's.
      if (!who || who.role !== "owner") return back(res, "/demo", "Only the owner can reset this demo. Switch to the owner first.", true);
      const fresh = await resetWorkspace(w.id);
      await signInWorkspace(res, req, fresh, "owner");
      return res.redirect(`/today?ok=${encodeURIComponent("Your demo was rebuilt from scratch. You are signed in as the owner.")}`);
    }
    // The shared showcase studio (no workspace) is reset only with the operator key.
    if (!isAdmin(req)) return back(res, "/demo", "Only the owner of a demo can reset it, from inside that demo. The shared showcase needs the operator key.", true);
    await rebuildShowcase();
    back(res, "/demo", "Showcase studio reseeded through the visitor seeding path.");
  }));
  /** Demo mode only: clear one customer's calls so Callback may ring them again today (the one-attempt-a-day limit
   * otherwise blocks a judge beat after any test call). Their money records are untouched; the planner re-checks
   * consent and calling hours as usual. */
  r.post("/demo/call-again", page(async (req, res) => {
    const who = await me(req);
    if (!config.demoMode) return back(res, "/demo", "Demo mode is off.", true);
    if (!who || who.role !== "owner") return back(res, "/demo", "Sign in as the owner first.", true);
    const db = await getDb();
    const byName = String(req.body.name ?? "").trim();
    const cust = (await db.query<{ id: string; name: string }>(byName ? "SELECT id, name FROM customers WHERE business_id = $1 AND name LIKE $2 LIMIT 1" : "SELECT id, name FROM customers WHERE business_id = $1 AND id = $2 LIMIT 1", [who.business_id, byName ? `${byName}%` : String(req.body.customer ?? "")])).rows[0];
    if (!cust) return back(res, "/demo", "No such customer.", true);
    await db.query("DELETE FROM callbacks WHERE customer_id = $1", [cust.id]);
    await db.query("DELETE FROM calls WHERE customer_id = $1 AND status <> 'in_progress'", [cust.id]);
    await planCalls(db, who.business_id, "demo");
    const call = (await db.query<{ id: string }>("SELECT id FROM calls WHERE customer_id = $1 AND status IN ('planned','blocked') ORDER BY created_at DESC LIMIT 1", [cust.id])).rows[0];
    back(res, call ? `/calls/${call.id}` : "/today", `${cust.name} can be called again today.`);
  }));
  /** Demo mode only: sign in as the owner or the front desk without a key. With private workspaces on (the default in
   * demo mode), that is the visitor's own workspace, created on the first tap; nobody signs into the shared showcase. */
  r.post("/demo/signin-as", page(async (req, res) => {
    if (!config.demoMode) return back(res, "/demo", "Demo mode is off.", true);
    const role = req.body.role === "staff" ? "staff" : "owner";
    if (config.workspaces.enabled) {
      const { w } = await ensureWorkspace(req);
      await signInWorkspace(res, req, w, role);
      return res.redirect(role === "owner" ? "/today" : "/calls");
    }
    const db = await getDb();
    const biz = await firstBiz(db);
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
  /** The studio clock (spec A4): owner only, this studio only. `days` moves it forward (the "+1 day" control). */
  r.post("/demo/clock", page(async (req, res) => {
    if (!config.demoMode) return back(res, "/demo", "Demo mode is off.", true);
    const p = await me(req);
    if (!p || p.role !== "owner") return back(res, "/demo", "Only the owner can move the studio clock.", true);
    const db = await getDb();
    const biz = await bizById(db, p.business_id);
    const days = Number(req.body.days ?? 0);
    const v = String(req.body.now ?? "").trim();
    let next: string | null;
    if (Number.isFinite(days) && days !== 0) next = new Date((biz.sim_now ? new Date(biz.sim_now) : new Date()).getTime() + Math.max(-7, Math.min(7, Math.round(days))) * 86400_000).toISOString();
    else if (req.body.morning === "1") next = demoClock().toISOString();
    else next = v ? new Date(v).toISOString() : null;
    if (next && Number.isNaN(new Date(next).getTime())) return back(res, "/demo", "That is not a date.", true);
    await db.query("UPDATE businesses SET sim_now = $2 WHERE id = $1", [biz.id, next]);
    await planCalls(db, biz.id, "demo");
    back(res, "/demo", next ? `Studio clock set to ${new Date(next).toLocaleString("en-AU", { timeZone: biz.tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} (${biz.tz}); calls re-planned.` : "Studio clock back to real time; calls re-planned.");
  }));
  r.post("/demo/plan", page(async (req, res) => {
    const p = await me(req);
    if (!p) return back(res, "/demo", "Sign in first.", true);
    const db = await getDb();
    const out = await planCalls(db, p.business_id, "demo");
    back(res, "/demo", `Planned ${out.planned}, blocked ${out.blocked}.`);
  }));
  r.post("/demo/fault", page(async (req, res) => {
    if (!config.demoMode) return back(res, "/demo", "Demo mode is off.", true);
    const p = await me(req);
    if (!p || p.role !== "owner") return back(res, "/demo", "Only the owner can make PayPal fail on purpose.", true);
    const method = String(req.body.method);
    if (!(FAULTABLE as readonly string[]).includes(method)) return back(res, "/demo", "Unknown method.", true);
    await armFault(method, req.body.kind === "lose_response" ? "lose_response" : "fail_503");
    back(res, "/demo", `Armed ${req.body.kind} on ${method}${currentWs() ? " in your demo only" : ""}.`);
  }));
  /** Makes every model call in this demo fail for a couple of minutes, to show the honest failure states. Owner only. */
  r.post("/demo/fault-ai", page(async (req, res) => {
    if (!config.demoMode) return back(res, "/demo", "Demo mode is off.", true);
    const p = await me(req);
    if (!p || p.role !== "owner") return back(res, "/demo", "Only the owner can make the AI fail on purpose.", true);
    if (req.body.off === "1") {
      await disarmAiFault();
      return back(res, "/demo", "The AI is back on.");
    }
    await armAiFault();
    back(res, "/demo", `The AI now fails${currentWs() ? " in your demo only" : ""} for ${AI_FAULT_MINUTES} minutes. Place a call or ask a question to see what happens.`);
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
