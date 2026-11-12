/**
 * Read endpoints for the web app (web/). Every number here comes from the same store, planner, gate, policy and
 * backtest functions the server-rendered pages use; nothing is recomputed differently. Actions are not duplicated:
 * the web app posts to the existing form routes with an `X-Callback-App` header and gets JSON back (see appJson).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Router, type NextFunction, type Request, type Response } from "express";
import { aiUsageSummary, brainKind, providerLabel } from "../ai/provider.js";
import { recentMessages, conversation, smsReady, telegramReady } from "../channels/index.js";
import { pushReady } from "../channels/push.js";
import { config, mayContactForReal } from "../config.js";
import { callbackSlots } from "../core/plans.js";
import { fmtLocal } from "../core/time.js";
import { getDb } from "../db.js";
import { CASES } from "../eval/adversarial.js";
import { personas } from "../eval/personas.js";
import { evalRows, summarise } from "../eval/store.js";
import { recentAudit, verifyChain } from "../guard/audit.js";
import { backtest, history, suggestAutonomy } from "../guard/backtest.js";
import { guardSettings, pendingApprovals } from "../guard/dryrun.js";
import { listKills } from "../guard/kill.js";
import { hasPasskey } from "../guard/passkey.js";
import { activePolicy, compilePolicy, listPolicies } from "../guard/policy.js";
import { FAULTABLE, paypal, paypalConfigured, WEBHOOK_EVENTS } from "../paypal/index.js";
import { protectedMode, safetyHolds } from "../safety/index.js";
import { scanMessage } from "../safety/readers.js";
import { optionsFor, SPLITTABLE } from "../services/money.js";
import { candidates } from "../services/planner.js";
import { balanceOf, bizById, callById, callsOf, customerById, customerByToken, customersOf, eventsOf, firstBiz, nowOf, obligationById, obligationsOf, owedToCustomer, type Obligation } from "../store.js";
import { loadRun, recentRuns } from "../trace.js";
import { liveCallFor, liveReady } from "../voice/live.js";
import { telephonyReady } from "../voice/telephony.js";
import { me, type Me } from "./auth.js";
import { workspaceOf } from "./workspace.js";
import { markStep } from "../services/workspaces.js";
import { DEMO_IMPERSONATION } from "./safety.js";
import { json } from "./common.js";
import { GtError } from "../lib/util.js";
import { LANG_NAME, langOf, normLang } from "../lib/lang.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCOPES = ["global", "calls", "agents", "action:charge", "action:invoice", "action:plan", "action:discount", "action:refund", "purpose:confirm_deposit", "purpose:chase_invoice", "purpose:cancel_class"];
const OPEN = (o: Obligation) => !["paid", "credited", "refunded", "void"].includes(o.status);

/** The web app's actions reuse the form routes: with X-Callback-App, a redirect becomes JSON {ok, message, to}. */
export function appJson(req: Request, res: Response, next: NextFunction) {
  if (!req.get("x-callback-app")) return next();
  const redirect = res.redirect.bind(res) as (a: number | string, b?: string) => void;
  (res as any).redirect = (a: number | string, b?: string) => {
    const url = String(typeof a === "number" ? b : a);
    if (/^https?:\/\//.test(url) && !url.startsWith(config.appUrl)) return res.json({ ok: true, to: url, external: true });
    const u = new URL(url, "http://x");
    const err = u.searchParams.get("err");
    const ok = u.searchParams.get("ok");
    u.searchParams.delete("err");
    u.searchParams.delete("ok");
    const to = u.pathname + (u.search || "") + (u.hash || "");
    if (err) return res.status(422).json({ ok: false, message: err, to });
    if (to.startsWith("/login")) return res.status(401).json({ ok: false, message: "Sign in first.", to });
    return res.json({ ok: true, message: ok ?? "", to });
  };
  void redirect;
  next();
}

export async function who(req: Request): Promise<Me> {
  const p = await me(req);
  if (!p) throw new GtError("Sign in first.", "unauthorized", 401);
  return p;
}
export async function owner(req: Request): Promise<Me> {
  const p = await who(req);
  if (p.role !== "owner") throw new GtError("Only the owner can see this.", "forbidden", 403);
  return p;
}

const callRow = (c: any, custs: Map<string, any>, obls: Map<string, Obligation>) => {
  const cu = custs.get(c.customer_id);
  const o = c.obligation_id ? obls.get(c.obligation_id) : null;
  return {
    id: c.id, status: c.status, purpose: c.purpose, outcome: c.outcome, reason: c.reason, mode: c.mode,
    customer: cu ? { id: cu.id, name: cu.name, tz: cu.tz } : null,
    item: o ? { id: o.id, title: o.title, kind: o.kind, balance_cents: balanceOf(o), owed_to_customer_cents: owedToCustomer(o), status: o.status } : null,
    scheduled_at: c.scheduled_at, scheduled_local: c.scheduled_at && cu ? fmtLocal(c.scheduled_at, cu.tz) : null,
    ended_at: c.ended_at, created_at: c.created_at, collected_cents: c.collected_cents, breaches: c.breaches, is_sample: Boolean(c.is_sample),
  };
};

function approvalView(a: any, obls: Map<string, Obligation>, custs: Map<string, any>, calls: any[]) {
  const pl = a.payload ?? {};
  const o = pl.entity === "obligation" ? obls.get(pl.entityId) : pl.entity === "call" ? obls.get(calls.find((c) => c.id === pl.entityId)?.obligation_id ?? "") : undefined;
  const cu = o ? custs.get(o.customer_id) : undefined;
  const callId = typeof pl.agentScope === "string" && pl.agentScope.startsWith("agent:") ? pl.agentScope.slice(6) : null;
  return {
    id: a.id, action: a.action, status: a.status, method: a.method, created_at: a.created_at, decided_at: a.decided_at,
    cents: pl.cents ?? null, discount_pct: pl.discountPct ?? null, instalments: pl.instalments ?? null, reason: pl.reason ?? "",
    safety_reasons: pl.safety_reasons ?? [], hash: a.payload_hash,
    customer: cu ? { id: cu.id, name: cu.name } : null, item: o ? { id: o.id, title: o.title, kind: o.kind, captured: Boolean(o.capture_id) } : null, call_id: callId,
    countersign: Number(pl.cents ?? 0) >= config.guard.countersignAboveCents,
  };
}

export function apiRouter(): Router {
  const r = Router();

  r.get("/api/app/session", json(async (req) => {
    const p = await me(req);
    const db = await getDb();
    const biz = p ? await bizById(db, p.business_id) : await firstBiz(db);
    const now = biz ? await nowOf(db, biz.id) : new Date();
    const pending = p?.role === "owner" ? (await pendingApprovals(p.business_id)).filter((a) => a.status === "pending").length : 0;
    return {
      me: p ? { name: p.name, role: p.role, business: p.business_name, lang: (p as { lang?: string }).lang ?? "en" } : null,
      business: biz ? { name: biz.name, tz: biz.tz, clock: now.toISOString(), clock_local: fmtLocal(now, biz.tz), pinned: Boolean(biz.sim_now) } : null,
      pending,
      demo: config.demoMode,
      workspace: (() => {
        const w = workspaceOf(req);
        return w ? { private: true, seed_state: w.seed_state, seed_note: w.seed_note, expires_at: w.expires_at, idle_hours: config.workspaces.idleHours, join_url: w.join_token ? `${config.appUrl}/demo/join/${w.join_token}` : null } : null;
      })(),
      integrations: { paypal: paypalConfigured() ? config.paypal.env : null, brain: brainKind(), brain_label: providerLabel(), phone: telephonyReady(), live_voice: liveReady(), sms: smsReady(), telegram: telegramReady(), push: pushReady(), telegram_bot: config.channels.telegramBot },
    };
  }));

  /** Public: what the landing page shows as a live preview. Only the demo studio, only when demo mode is on. */
  r.get("/api/app/preview", json(async () => {
    const db = await getDb();
    const biz = await firstBiz(db);
    if (!biz || !config.demoMode) return { business: null };
    const custs = new Map((await customersOf(db, biz.id)).map((c) => [c.id, c]));
    const obls = await obligationsOf(db, biz.id);
    const cands = await candidates(db, biz.id);
    const ended = (await callsOf(db, biz.id, { status: ["ended"], limit: 20 })).find((c) => c.transcript.length >= 3);
    return {
      business: { name: biz.name, tz: biz.tz },
      owed_cents: obls.filter(OPEN).reduce((s, o) => s + balanceOf(o), 0),
      lines: cands.slice(0, 6).map((c) => ({ name: c.customer.name.split(" ")[0], purpose: c.purpose, cents: c.obligation.kind === "class_cancel" ? owedToCustomer(c.obligation) : balanceOf(c.obligation), ok: c.verdict.ok, why: c.verdict.ok ? c.reason : c.verdict.reasons[0] })),
      call: ended ? { customer: custs.get(ended.customer_id)?.name.split(" ")[0] ?? "", outcome: ended.outcome, turns: ended.transcript.filter((t) => t.who !== "system").slice(0, 6).map((t) => ({ who: t.who, text: t.text.slice(0, 220) })), money: ended.transcript.filter((t) => t.who === "system").map((t) => t.text).slice(0, 2) } : null,
    };
  }));

  r.get("/api/app/today", json(async (req) => {
    const p = await who(req);
    const db = await getDb();
    const now = await nowOf(db, p.business_id);
    const biz = await bizById(db, p.business_id);
    const calls = await callsOf(db, p.business_id, { limit: 300 });
    const custs = new Map((await customersOf(db, p.business_id)).map((c) => [c.id, c]));
    const obls = new Map((await obligationsOf(db, p.business_id)).map((o) => [o.id, o]));
    const ended = calls.filter((c) => c.status === "ended");
    const today = ended.filter((c) => c.ended_at && Date.now() - new Date(c.ended_at).getTime() < 86400_000);
    const approvals = p.role === "owner" ? (await pendingApprovals(p.business_id)).filter((a) => a.status === "pending").map((a) => approvalView(a, obls, custs, calls)) : [];
    const rows = calls.map((c) => callRow(c, custs, obls));
    const owed = [...obls.values()].filter((o) => OPEN(o) && o.kind !== "class_cancel").reduce((s, o) => s + balanceOf(o), 0);
    return {
      now: now.toISOString(), now_local: fmtLocal(now, biz.tz), tz: biz.tz,
      kpis: { ready: rows.filter((c) => ["planned", "ringing", "in_progress"].includes(c.status)).length, blocked: rows.filter((c) => c.status === "blocked").length, collected_cents: today.reduce((s, c) => s + c.collected_cents, 0), finished_today: today.length, waiting: approvals.length, owed_cents: owed },
      approvals,
      live: rows.filter((c) => ["ringing", "in_progress"].includes(c.status)),
      ready: rows.filter((c) => c.status === "planned"),
      blocked: rows.filter((c) => c.status === "blocked"),
      finished: rows.filter((c) => c.status === "ended").slice(0, 12),
    };
  }));

  r.get("/api/app/calls", json(async (req) => {
    const p = await who(req);
    const db = await getDb();
    const status = typeof req.query.status === "string" && req.query.status ? [req.query.status as any] : undefined;
    const calls = await callsOf(db, p.business_id, { status, limit: 200 });
    const custs = new Map((await customersOf(db, p.business_id)).map((c) => [c.id, c]));
    const obls = new Map((await obligationsOf(db, p.business_id)).map((o) => [o.id, o]));
    return calls.map((c) => callRow(c, custs, obls));
  }));

  /** A machine translation of the call's transcript for the reader (spec item 5.2). The original stays as spoken. */
  r.post("/api/app/calls/:id/translate", json(async (req) => {
    const p = await who(req);
    const lang = normLang(req.body?.lang) ?? langOf(req);
    const db = await getDb();
    const { translateCall } = await import("../services/translate.js");
    return { ok: true, lang, translation: await translateCall(db, req.params.id, p.business_id, lang) };
  }));

  r.get("/api/app/calls/:id", json(async (req) => {
    const p = await who(req);
    const db = await getDb();
    const c = await callById(db, req.params.id, p.business_id);
    if (c.status === "blocked") await markStep("opened_blocked_call").catch(() => undefined);
    const cu = await customerById(db, c.customer_id);
    const o = c.obligation_id ? await obligationById(db, c.obligation_id) : null;
    const opts = o ? await optionsFor(db, p.business_id, o) : null;
    const trace = c.run_id ? await loadRun(c.run_id) : null;
    const now = await nowOf(db, p.business_id);
    const pol = await activePolicy(p.business_id, db);
    const events = await eventsOf(db, p.business_id, { callId: c.id }, 30);
    const links = o ? (await db.query<any>("SELECT id, amount_cents, paypal_order_id, approve_url, status, created_at FROM pay_links WHERE obligation_id = $1 ORDER BY created_at", [o.id])).rows : [];
    const invoices = o ? (await db.query<any>("SELECT id, amount_cents, paypal_invoice_id, status, created_at FROM invoices WHERE obligation_id = $1 ORDER BY created_at", [o.id])).rows : [];
    const plans = o ? (await db.query<any>("SELECT id, option, subscription_id, approve_url, status, created_at FROM instalment_plans WHERE obligation_id = $1 ORDER BY created_at", [o.id])).rows : [];
    const refunds = o ? (await db.query<any>("SELECT id, amount_cents, paypal_refund_id, status, created_at FROM refunds WHERE obligation_id = $1 ORDER BY created_at", [o.id])).rows : [];
    const holds = o ? (await db.query<any>("SELECT id, amount_cents, paypal_order_id, authorization_id, approve_url, status, via, created_at FROM holds WHERE obligation_id = $1 AND status NOT IN ('creating') ORDER BY created_at", [o.id])).rows : [];
    const approvals = (await pendingApprovals(p.business_id)).filter((a) => a.payload?.agentScope === `agent:${c.id}` || (o && a.payload?.entityId === o.id));
    return {
      call: { id: c.id, status: c.status, purpose: c.purpose, outcome: c.outcome, reason: c.reason, mode: c.mode, transcript: c.transcript, state: c.state, consent_ok: c.consent_ok, hours_ok: c.hours_ok, breaches: c.breaches, collected_cents: c.collected_cents, started_at: c.started_at, ended_at: c.ended_at, run_id: c.run_id, verify_code: (c.state as any)?.verify_code ?? null, is_sample: Boolean((c as any).is_sample), lang: c.lang ?? null, translations: c.translations ?? {} },
      customer: { id: cu.id, name: cu.name, tz: cu.tz, dnc: cu.dnc, consent: cu.consent, token: p.role === "owner" ? cu.token : null, phone_live: telephonyReady() && mayContactForReal(cu.phone) },
      item: o ? { id: o.id, title: o.title, kind: o.kind, note: o.note, amount_cents: o.amount_cents, discount_cents: o.discount_cents, settled_cents: o.settled_cents, balance_cents: balanceOf(o), owed_to_customer_cents: owedToCustomer(o), status: o.status, due_local: o.due_at ? fmtLocal(o.due_at, cu.tz) : null, appointment_local: o.appointment_at ? fmtLocal(o.appointment_at, cu.tz) : null, captured: Boolean(o.capture_id), paypal_order_id: o.paypal_order_id, paypal_invoice_id: o.paypal_invoice_id, subscription_id: o.subscription_id } : null,
      offers: opts ? { discounts: opts.discounts.map((d) => ({ id: d.id, label: d.label, pct: d.pct })), plans: opts.plans.map((x) => ({ id: x.id, label: x.label })), slots: callbackSlots(now, cu.tz, pol.rules).map((s) => ({ id: s.id, label: s.label })) } : null,
      money: { links, invoices, plans: plans.map((x: any) => ({ ...x, option: typeof x.option === "string" ? JSON.parse(x.option) : x.option })), refunds, holds },
      approvals: approvals.map((a) => ({ id: a.id, action: a.action, status: a.status, cents: a.payload?.cents ?? null, reason: a.payload?.reason ?? "", safety_reasons: a.payload?.safety_reasons ?? [] })),
      trace: trace ? trace.steps.map((s: any) => ({ seq: s.step ?? s.seq, actor: s.actor, tool: s.tool, gate: s.gate, policy: s.policy, args: s.args, result: s.result, pp_request_id: s.pp_request_id, pp_debug_id: s.pp_debug_id, duration_ms: s.duration_ms, at: s.at })) : [],
      events: events.map((e: any) => ({ at: e.at, type: e.type, summary: e.summary, actor: e.actor })),
      samples: personas().filter((x) => x.purpose === c.purpose).slice(0, 6).flatMap((x) => x.lines.slice(0, 1)),
      voice: { live: liveReady(), model: config.ai.models.live, on_now: Boolean(liveCallFor(c.id)), transport: (c.state as any)?.live_transport ?? null, phone: telephonyReady() && liveReady() && config.voice.callMyPhoneCountries.length > 0, phone_countries: config.voice.callMyPhoneCountries, phone_why_off: !telephonyReady() ? "No Twilio number is set on this deployment." : !config.voice.callMyPhoneCountries.length ? "The operator has not chosen which countries the demo may dial (CB_CALL_MY_PHONE_COUNTRIES)." : null, cap_seconds: config.voice.liveCapSeconds, brain: brainKind() },
      signals: (c.state as any)?.signals ?? null,
      approval_cards: approvals.filter((a) => a.status === "pending").map((a) => approvalView(a, new Map(o ? [[o.id, o]] : []), new Map([[cu.id, cu]]), [c])),
      passkey: await hasPasskey(p.business_id, db),
    };
  }));

  r.get("/api/app/customers", json(async (req) => {
    const p = await who(req);
    const db = await getDb();
    const custs = await customersOf(db, p.business_id);
    const obls = await obligationsOf(db, p.business_id);
    return custs.map((c) => {
      const mine = obls.filter((o) => o.customer_id === c.id);
      return { id: c.id, name: c.name, phone: c.phone, email: c.email, tz: c.tz, dnc: c.dnc, consent: c.consent ? { granted_at: c.consent.granted_at, source: c.consent.source, revoked_at: c.consent.revoked_at } : null, owed_cents: mine.filter(OPEN).filter((o) => o.kind !== "class_cancel").reduce((s, o) => s + balanceOf(o), 0), owed_to_them_cents: mine.reduce((s, o) => s + owedToCustomer(o), 0), open_items: mine.filter(OPEN).length };
    });
  }));

  r.get("/api/app/customers/:id", json(async (req) => {
    const p = await who(req);
    const db = await getDb();
    const c = await customerById(db, req.params.id, p.business_id);
    const obls = await obligationsOf(db, p.business_id, c.id);
    const cancelled = new Set(obls.map((o) => o.source_id).filter(Boolean));
    const calls = await callsOf(db, p.business_id, { customerId: c.id, limit: 30 });
    const events = await eventsOf(db, p.business_id, { customerId: c.id }, 40);
    return {
      customer: { id: c.id, name: c.name, phone: c.phone, email: c.email, tz: c.tz, lang: c.lang, notes: c.notes, dnc: c.dnc, consent: c.consent, link: p.role === "owner" ? `/c/${c.token}` : null },
      items: obls.map((o) => ({ id: o.id, kind: o.kind, title: o.title, note: o.note, amount_cents: o.amount_cents, discount_cents: o.discount_cents, settled_cents: o.settled_cents, balance_cents: balanceOf(o), owed_to_customer_cents: owedToCustomer(o), status: o.status, due_local: o.due_at ? fmtLocal(o.due_at, c.tz) : null, appointment_local: o.appointment_at ? fmtLocal(o.appointment_at, c.tz) : null, captured: Boolean(o.capture_id), can_cancel: o.kind === "deposit" && o.status === "paid" && o.settled_cents > 0 && !cancelled.has(o.id) })),
      calls: calls.map((x) => ({ id: x.id, status: x.status, purpose: x.purpose, outcome: x.outcome, reason: x.reason, created_at: x.created_at })),
      events: events.map((e: any) => ({ at: e.at, type: e.type, summary: e.summary, actor: e.actor })),
    };
  }));

  r.get("/api/app/policy", json(async (req) => {
    const p = await owner(req);
    const db = await getDb();
    const pol = await activePolicy(p.business_id, db);
    const limits = await guardSettings(p.business_id, db);
    const draftText = typeof req.query.draft === "string" && req.query.draft.trim() ? req.query.draft.slice(0, 4000) : null;
    const compiled = draftText ? await compilePolicy(draftText) : null;
    const bt = backtest(await history(p.business_id, db), compiled?.rules ?? pol.rules, limits);
    return { active: { text: pol.text, rules: pol.rules }, draft: compiled ? { text: draftText, rules: compiled.rules, refused: compiled.refused, unexpressed: compiled.unexpressed, source: compiled.source, ai_failed: Boolean(compiled.ai_error) } : null, backtest: bt, autonomy: await suggestAutonomy(p.business_id, db), limits, history: (await listPolicies(p.business_id)).slice(0, 12).map((x: any) => ({ id: x.id, status: x.status, source: x.source, text: x.text, created_at: x.created_at })) };
  }));

  r.get("/api/app/guard", json(async (req) => {
    const p = await owner(req);
    if ((await (await getDb()).query("SELECT 1 FROM approvals WHERE status = 'pending' LIMIT 1")).rows.length) await markStep("viewed_hold").catch(() => undefined);
    const db = await getDb();
    const custs = new Map((await customersOf(db, p.business_id)).map((c) => [c.id, c]));
    const obls = new Map((await obligationsOf(db, p.business_id)).map((o) => [o.id, o]));
    const calls = await callsOf(db, p.business_id, { limit: 300 });
    const all = (await pendingApprovals(p.business_id)).map((a) => approvalView(a, obls, custs, calls));
    const kills = await listKills();
    const chain = await verifyChain(db);
    return {
      pending: all.filter((a) => a.status === "pending"), decided: all.filter((a) => a.status !== "pending").slice(0, 30),
      limits: await guardSettings(p.business_id, db), autonomy: await suggestAutonomy(p.business_id, db), passkey: await hasPasskey(p.business_id, db), countersign_cents: config.guard.countersignAboveCents,
      kills: SCOPES.map((s) => { const k = kills.find((x: any) => x.scope === s); return { scope: s, engaged: Boolean(k?.engaged), reason: k?.reason ?? null }; }),
      chain: { ok: chain.ok, rows: chain.rows, head: chain.head, broken_at: chain.broken_at ?? null },
      audit: (await recentAudit(30)).map((a: any) => ({ seq: a.seq, at: a.at, kind: a.kind, entity: a.entity, entity_id: a.entity_id, hash: String(a.hash).slice(0, 16) })),
    };
  }));

  r.get("/api/app/money", json(async (req) => {
    const p = await owner(req);
    await markStep("opened_money").catch(() => undefined);
    const db = await getDb();
    const custs = new Map((await customersOf(db, p.business_id)).map((c) => [c.id, c]));
    const obls = await obligationsOf(db, p.business_id);
    const byId = new Map(obls.map((o) => [o.id, o]));
    const who = (oid: string) => { const o = byId.get(oid); const c = o ? custs.get(o.customer_id) : null; return { item: o?.title ?? "", customer: c?.name ?? "", customer_id: c?.id ?? null }; };
    const q = async (sql: string) => (await db.query<any>(sql, [p.business_id])).rows;
    const links = await q("SELECT * FROM pay_links WHERE business_id = $1 ORDER BY created_at DESC LIMIT 40");
    const invs = await q("SELECT * FROM invoices WHERE business_id = $1 ORDER BY created_at DESC LIMIT 40");
    const plans = await q("SELECT * FROM instalment_plans WHERE business_id = $1 ORDER BY created_at DESC LIMIT 40");
    const refunds = await q("SELECT * FROM refunds WHERE business_id = $1 ORDER BY created_at DESC LIMIT 40");
    const holds = await q("SELECT * FROM holds WHERE business_id = $1 ORDER BY created_at DESC LIMIT 40");
    const hooks = (await db.query<any>("SELECT event_type, verified, received_at FROM webhook_events ORDER BY received_at DESC LIMIT 20")).rows;
    const moves = [
      ...links.map((x: any) => ({ kind: "pay_link", id: x.id, at: x.created_at, cents: Number(x.amount_cents), paypal_id: x.paypal_order_id, status: x.status, approve_url: x.approve_url, ...who(x.obligation_id), call_id: x.call_id })),
      ...invs.map((x: any) => ({ kind: "invoice", id: x.id, at: x.created_at, cents: Number(x.amount_cents), paypal_id: x.paypal_invoice_id, status: x.status, approve_url: x.href, ...who(x.obligation_id), call_id: x.call_id })),
      ...plans.map((x: any) => { const opt = typeof x.option === "string" ? JSON.parse(x.option) : x.option; return { kind: "plan", id: x.id, at: x.created_at, cents: Number(opt?.per_cents ?? 0) * Number(opt?.instalments ?? 1), label: opt?.label, paypal_id: x.subscription_id, status: x.status, approve_url: x.approve_url, ...who(x.obligation_id), call_id: x.call_id }; }),
      ...refunds.map((x: any) => ({ kind: "refund", id: x.id, at: x.created_at, cents: Number(x.amount_cents), paypal_id: x.paypal_refund_id, status: x.status, approve_url: null, ...who(x.obligation_id), call_id: x.call_id })),
      ...holds.filter((x: any) => !["creating", "failed"].includes(x.status)).map((x: any) => ({ kind: "hold", id: x.id, at: x.created_at, cents: Number(x.amount_cents), paypal_id: x.authorization_id ?? x.paypal_order_id, status: x.status === "authorized" ? "held" : x.status, approve_url: x.status === "link_sent" ? x.approve_url : null, ...who(x.obligation_id), call_id: x.call_id })),
    ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const captures = obls.filter((o) => o.capture_id).map((o) => ({ item: o.title, customer: custs.get(o.customer_id)?.name ?? "", capture_id: o.capture_id, cents: o.settled_cents, status: o.status }));
    let balances: { currency: string; value: string }[] = [];
    let paypalReadable = false;
    if (paypalConfigured()) {
      try {
        balances = (await paypal().listBalances()).map((b: any) => ({ currency: b.currency, value: b.total_balance?.value }));
        paypalReadable = true;
      } catch { /* shown as unavailable */ }
    }
    return {
      totals: { owed_cents: obls.filter(OPEN).filter((o) => o.kind !== "class_cancel").reduce((s, o) => s + balanceOf(o), 0), paid_cents: obls.filter((o) => o.status === "paid").reduce((s, o) => s + o.settled_cents, 0), owed_back_cents: obls.reduce((s, o) => s + owedToCustomer(o), 0), refunded_cents: refunds.filter((x: any) => !["failed", "creating"].includes(x.status)).reduce((s: number, x: any) => s + Number(x.amount_cents), 0) },
      moves, captures, hooks, balances, holds: holds.map((x: any) => ({ id: x.id, status: x.status, cents: Number(x.amount_cents), order_id: x.paypal_order_id, authorization_id: x.authorization_id, capture_id: x.capture_id, expires_at: x.expires_at, via: x.via, decided_at: x.decided_at, ...who(x.obligation_id), call_id: x.call_id, appointment_at: byId.get(x.obligation_id)?.appointment_at ?? null })), paypal: { configured: paypalConfigured(), env: config.paypal.env, readable: paypalReadable }, webhook_events: WEBHOOK_EVENTS, faultable: FAULTABLE,
    };
  }));

  r.get("/api/app/safety", json(async (req) => {
    const p = await owner(req);
    const db = await getDb();
    const inbound = (await db.query<any>("SELECT channel, address, body, created_at FROM channel_messages WHERE direction = 'in' ORDER BY created_at DESC LIMIT 15")).rows;
    const replaced = Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM agent_trace WHERE tool = 'safety.agent_line'")).rows[0]?.n ?? 0);
    const verified = Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM calls WHERE state->>'verify_code' IS NOT NULL AND business_id = $1", [p.business_id])).rows[0]?.n ?? 0);
    const holds = (await safetyHolds(db)).filter((h: any) => h.payload?.businessId === p.business_id || !h.payload?.businessId).slice(0, 20).map((h: any) => ({ id: h.id, action: h.action, status: h.status, cents: Number(h.payload?.cents ?? 0), reasons: h.payload?.safety_reasons ?? [], rule: h.payload?.safety_rule ?? null, created_at: h.created_at }));
    return { protected: await protectedMode(p.business_id, db), holds, inbound: await Promise.all(inbound.map(async (m: any) => ({ ...m, scan: await scanMessage(m.body, { businessId: p.business_id, q: db }) }))), replaced, verified_calls: verified, demo_message: config.demoMode ? DEMO_IMPERSONATION : null };
  }));

  r.get("/api/app/messages", json(async (req) => {
    const p = await owner(req);
    const db = await getDb();
    const addr = typeof req.query.address === "string" ? req.query.address : null;
    const tg = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM party_links WHERE channel = 'telegram' AND party = 'owner' AND party_id = $1", [p.business_id])).rows[0]?.n ?? 0;
    return { owner_address: `owner:${p.business_id}`, telegram_linked: tg, recent: (await recentMessages(80)).map((m: any) => ({ id: m.id, channel: m.channel, direction: m.direction, address: m.address, body: m.body, status: m.status, at: m.created_at })), thread: (await conversation(addr ?? `owner:${p.business_id}`)).map((m: any) => ({ direction: m.direction, body: m.body, channel: m.channel, status: m.status, at: m.created_at })), address: addr };
  }));

  r.get("/api/app/proof", json(async (req) => {
    const p = await who(req);
    const db = await getDb();
    const calls = await callsOf(db, p.business_id, { limit: 500 });
    const ended = calls.filter((c) => c.status === "ended");
    const tr = (await db.query<any>("SELECT count(*)::int AS steps, count(DISTINCT run_id)::int AS runs, count(*) FILTER (WHERE actor = 'paypal')::int AS paypal, count(*) FILTER (WHERE gate IN ('denied','held','dry_run_refused'))::int AS blocked FROM agent_trace")).rows[0];
    const pol = await activePolicy(p.business_id, db);
    const bt = backtest(await history(p.business_id, db), pol.rules, await guardSettings(p.business_id, db));
    const chain = await verifyChain(db);
    const usage = await aiUsageSummary();
    return {
      calls_ended: ended.length, collected_cents: ended.reduce((s, c) => s + c.collected_cents, 0), breaches_refused: calls.reduce((s, c) => s + c.breaches, 0), quarantined: calls.reduce((s, c) => s + c.transcript.filter((t) => t.quarantined?.length).length, 0),
      trace: tr, chain: { ok: chain.ok, rows: chain.rows },
      model: { label: providerLabel(), usage },
      backtest: { cases: bt.cases, run: bt.run, wait: bt.wait, deny: bt.deny, collected_auto_cents: bt.collected_auto_cents, minutes_saved: bt.minutes_saved, breaches_prevented: bt.breaches_prevented },
      evals: { personas: await summarise("personas"), adversarial: await summarise("adversarial"), persona_cases: personas().length, attack_cases: CASES.length },
      runs: (await recentRuns(40)).map((x: any) => ({ id: x.id, subject: x.subject, actor: x.actor, agent_id: x.agent_id, steps: Number(x.steps), paypal_calls: Number(x.paypal_calls), blocked: Number(x.blocked), status: x.status, started_at: x.started_at })),
      app_url: config.appUrl,
    };
  }));

  r.get("/api/app/evals", json(async (req) => {
    await who(req);
    const suite = req.query.suite === "adversarial" ? "adversarial" : "personas";
    const f = { arm: typeof req.query.arm === "string" && req.query.arm ? req.query.arm : undefined, outcome: req.query.outcome === "correct" || req.query.outcome === "wrong" ? (req.query.outcome as "correct" | "wrong") : undefined, trap: typeof req.query.trap === "string" && req.query.trap ? req.query.trap : undefined };
    return { suite, summary: await summarise(suite), rows: (await evalRows(suite, f, 300)).map((x: any) => ({ case_id: x.case_id, arm: x.arm, expected: x.expected, actual: x.actual, correct: Boolean(x.correct), kind: x.detail?.trap_kind ?? null, naive_cents: Number(x.naive_paid_cents), ours_cents: Number(x.ours_paid_cents) })) };
  }));

  r.get("/api/app/trace/:id", json(async (req) => {
    const p = await me(req);
    const t = await loadRun(req.params.id);
    if (!t) throw new GtError("No such run", "not_found", 404);
    if (!p && !config.demoMode) throw new GtError("Sign in first.", "unauthorized", 401);
    return { run: t.run, steps: t.steps };
  }));

  r.get("/api/app/demo", json(async (req) => {
    const p = await me(req);
    const db = await getDb();
    const biz = p ? await bizById(db, p.business_id) : await firstBiz(db);
    const custs = biz ? new Map((await customersOf(db, biz.id)).map((c) => [c.id, c])) : new Map();
    const calls = biz && p ? await callsOf(db, biz.id, { status: ["planned", "blocked"], limit: 50 }) : [];
    const people = biz ? (await db.query<any>("SELECT name, role FROM people WHERE business_id = $1 ORDER BY role DESC, name", [biz.id])).rows : [];
    const keysRow = p?.role === "owner" && config.demoMode ? (await db.query<{ value: string }>("SELECT value FROM settings WHERE key = 'demo_keys'")).rows[0] : null;
    return {
      demo: config.demoMode, seeded: Boolean(biz), business: biz ? { name: biz.name, clock: biz.sim_now, tz: biz.tz } : null, people,
      customers: p && biz ? [...custs.values()].map((c) => ({ id: c.id, name: c.name })) : [],
      calls: calls.map((c) => ({ id: c.id, label: `${custs.get(c.customer_id)?.name ?? "?"}: ${c.purpose.replace(/_/g, " ")} (${c.status})` })),
      personas: personas().map((x) => ({ id: x.id, purpose: x.purpose })), faultable: FAULTABLE,
      keys: keysRow ? JSON.parse(keysRow.value) : null,
    };
  }));

  /**
   * Languages (spec B1.2): the page language is remembered per person (people.lang) as well as on the device. A visitor
   * who isn't signed in keeps it on the device only. A customer's choice on their own page is the language Callback
   * calls and texts them in.
   */
  r.post("/api/app/me/lang", json(async (req) => {
    const lang = normLang(req.body?.lang);
    if (!lang) throw new GtError("Pick English, Hindi, Indonesian or Brazilian Portuguese.", "bad_request", 400);
    const p = await me(req);
    if (p) await (await getDb()).query("UPDATE people SET lang = $2 WHERE id = $1", [p.id, lang]);
    return { ok: true, lang, saved_for: p ? "person" : "device" };
  }));
  r.post("/api/app/c/:token/lang", json(async (req) => {
    const lang = normLang(req.body?.lang);
    if (!lang) throw new GtError("Pick English, Hindi, Indonesian or Brazilian Portuguese.", "bad_request", 400);
    const db = await getDb();
    const c = await customerByToken(db, req.params.token);
    await db.query("UPDATE customers SET lang = $2 WHERE id = $1", [c.id, lang]);
    return { ok: true, lang };
  }));
  r.post("/api/app/customers/:id/lang", json(async (req) => {
    const p = await who(req);
    const lang = normLang(req.body?.lang);
    if (!lang) throw new GtError("Pick English, Hindi, Indonesian or Brazilian Portuguese.", "bad_request", 400);
    const db = await getDb();
    const c = await customerById(db, req.params.id, p.business_id);
    await db.query("UPDATE customers SET lang = $2 WHERE id = $1", [c.id, lang]);
    return { ok: true, lang, message: `${c.name} is now called and texted in ${LANG_NAME[lang]}.` };
  }));

  /** The customer's own page, by their private token. Never exposes other customers or the owner's notes. */
  r.get("/api/app/c/:token", json(async (req) => {
    const db = await getDb();
    const c = await customerByToken(db, req.params.token);
    const biz = await bizById(db, c.business_id);
    const obls = await obligationsOf(db, c.business_id, c.id);
    const pol = await activePolicy(c.business_id, db);
    const lastCall = (await callsOf(db, c.business_id, { customerId: c.id, limit: 1 }))[0];
    const msgs = (await db.query<any>("SELECT body, channel, created_at FROM channel_messages WHERE address = $1 AND direction = 'out' ORDER BY created_at DESC LIMIT 6", [`customer:${c.token}`])).rows;
    // Payment plans the owner's rules allow for each open invoice. The numbers come from the rules, never typed in.
    const plans = new Map<string, { id: string; label: string }[]>();
    for (const o of obls.filter(OPEN)) if (o.kind === "invoice" && SPLITTABLE.has(o.status)) plans.set(o.id, (await optionsFor(db, c.business_id, o)).plans.map((p) => ({ id: p.id, label: p.label })));
    const holdBy = new Map<string, any>();
    for (const h of (await db.query<any>("SELECT obligation_id, status, amount_cents, authorization_id, expires_at FROM holds WHERE business_id = $1 AND status IN ('link_sent','authorized','captured','voided') ORDER BY created_at", [c.business_id])).rows) holdBy.set(h.obligation_id, h);
    return {
      business: { name: biz.name }, first_name: c.name.split(" ")[0], tz: c.tz, lang: c.lang,
      verify_code: (lastCall?.state as any)?.verify_code ?? null, last_call_at: lastCall?.started_at ?? null,
      open: obls.filter(OPEN).map((o) => ({ id: o.id, kind: o.kind, title: o.title, note: o.kind === "class_cancel" ? o.note : "", balance_cents: balanceOf(o), owed_to_you_cents: owedToCustomer(o), discount_cents: o.discount_cents, status: o.status, due_local: o.due_at ? fmtLocal(o.due_at, c.tz) : null, appointment_local: o.appointment_at ? fmtLocal(o.appointment_at, c.tz) : null, paid_by_paypal: Boolean(o.capture_id), plans: plans.get(o.id) ?? [], hold: holdBy.get(o.id) ? { status: holdBy.get(o.id).status, cents: Number(holdBy.get(o.id).amount_cents), authorization_id: holdBy.get(o.id).authorization_id, expires_at: holdBy.get(o.id).expires_at } : null })),
      settled: await Promise.all(obls.filter((o) => !OPEN(o)).map(async (o) => ({ id: o.id, title: o.title, status: o.status, cents: o.settled_cents, capture_id: o.capture_id, via_wallet: o.paypal_order_id ? (await db.query("SELECT 1 FROM pay_links WHERE paypal_order_id = $1 AND via = 'demo_wallet'", [o.paypal_order_id])).rows.length > 0 : false }))),
      demo_wallet: config.demoMode && Boolean(config.paypal.demoVaultToken),
      messages: msgs,
      calls: { dnc: c.dnc, consent: c.consent ? { granted_on: c.consent.granted_at.slice(0, 10), revoked: Boolean(c.consent.revoked_at) } : null, hours: pol.rules.hours, slots: !c.dnc && c.consent && !c.consent.revoked_at ? callbackSlots(await nowOf(db, c.business_id), c.tz, pol.rules, 6).map((s) => ({ at: s.at, label: s.label })) : [] },
      telegram: `https://t.me/${config.channels.telegramBot}?start=callback-${c.token}`,
    };
  }));

  return r;
}

/** Serves the built web app for browser page loads. API, webhooks, static files and non-browser clients fall through. */
export function webApp() {
  const dist = join(root, "dist", "client");
  const SKIP = /^\/(api|webhooks|static|assets|mcp|healthz|llms\.txt|skill\.md|manifest\.webmanifest|sw\.js|push|voice|connect|favicon|fonts|robots\.txt)(\/|$)|^\/c\/[^/]+\/mcp|^\/ops\/eval(\.csv|\/[^/]+\.md)/;
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" || SKIP.test(req.path) || req.query.classic === "1") return next();
    if (!(req.get("accept") ?? "").includes("text/html")) return next();
    let index: string;
    try {
      index = readFileSync(join(dist, "index.html"), "utf8"); // read each time: a rebuild never leaves stale asset names
    } catch {
      return next(); // web app not built: the server-rendered pages answer
    }
    res.set("Cache-Control", "no-cache").type("html").send(index);
  };
}
export const webDist = () => join(root, "dist", "client");
