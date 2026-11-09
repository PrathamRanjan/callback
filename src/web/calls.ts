/**
 * Call pages: the list, one call with its transcript, the in-app simulator (type as the customer or pick a persona
 * line), the live-voice session (OpenAI Realtime over WebRTC) and its tool callback, and the Twilio voice webhooks.
 */
import { Router, type Request } from "express";
import { fmtLocal } from "../core/time.js";
import { getDb } from "../db.js";
import { GtError } from "../lib/util.js";
import { customerSays, endCall, skipCall, startCall } from "../services/calls.js";
import { optionsFor } from "../services/money.js";
import { personas } from "../eval/personas.js";
import { balanceOf, callById, callsOf, customerById, customersOf, eventsOf, nowOf, obligationById, obligationsOf } from "../store.js";
import { loadRun, renderTrace } from "../trace.js";
import { realtimeReady, realtimeInstructions, realtimeTools, mintClientSecret } from "../voice/realtime.js";
import { executeRealtimeTool } from "../voice/tools.js";
import { gatherTwiml, openingTwiml, placeCall, recordVoiceEvent, statusEvent, telephonyReady, webhookAuthorised } from "../voice/telephony.js";
import { callbackSlots } from "../core/plans.js";
import { activePolicy } from "../guard/policy.js";
import { act, authed, requireOwner, type Me } from "./auth.js";
import { back, json, page } from "./common.js";
import { fmtDate, html, jsonBlock, pill, raw } from "./html.js";
import { money, ownerPage, purposeLabel } from "./views.js";

const fullUrl = (req: Request) => `${req.protocol}://${req.get("host")}${req.originalUrl}`;

export function callsRouter(): Router {
  const r = Router();

  r.get("/calls", authed(async (req, res, p) => {
    const db = await getDb();
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const calls = await callsOf(db, p.business_id, { status: status ? [status as any] : undefined, limit: 200 });
    const custs = new Map((await customersOf(db, p.business_id)).map((c) => [c.id, c]));
    const chip = (label: string, v: string) => html`<a class="chip ${v === status ? "on" : ""}" href="/calls${v ? `?status=${v}` : ""}">${label}</a>`;
    res.send(await ownerPage(req, p, "Calls", html`<h1>Calls</h1><div class="chips">${chip("All", "")}${chip("Planned", "planned")}${chip("Blocked", "blocked")}${chip("In progress", "in_progress")}${chip("Ended", "ended")}${chip("Skipped", "skipped")}</div>
<div class="card"><div class="table-wrap"><table><tr><th>Created</th><th>Customer</th><th>Purpose</th><th>Mode</th><th>Status</th><th>Outcome</th><th>Collected</th><th>Why</th><th></th></tr>
${calls.map((c) => html`<tr><td class="small">${fmtDate(c.created_at)}</td><td>${custs.get(c.customer_id)?.name}</td><td>${purposeLabel[c.purpose]}</td><td class="small">${c.mode}</td><td>${pill(c.status)}</td><td class="small">${c.outcome ?? ""}</td><td>${money(c.collected_cents)}</td><td class="small">${c.reason}</td><td><a class="btn small" href="/calls/${c.id}">Open</a></td></tr>`)}
</table></div>${calls.length ? "" : html`<div class="empty">No calls match.</div>`}</div>`));
  }));

  r.get("/calls/:id", authed(async (req, res, p) => {
    const db = await getDb();
    const c = await callById(db, req.params.id, p.business_id);
    const cu = await customerById(db, c.customer_id);
    const o = c.obligation_id ? await obligationById(db, c.obligation_id) : null;
    const opts = o ? await optionsFor(db, p.business_id, o) : null;
    const trace = c.run_id ? await loadRun(c.run_id) : null;
    const sample = personas().filter((x) => x.purpose === c.purpose).slice(0, 6);
    const events = await eventsOf(db, p.business_id, { callId: c.id }, 20);
    const live = c.status === "in_progress";
    const body = html`<p><a href="/calls">← Calls</a></p><h1>${purposeLabel[c.purpose]}: ${cu.name}</h1>
<p class="muted">${pill(c.status)} ${c.mode} · ${c.reason}${c.outcome ? ` · outcome: ${c.outcome.replace(/_/g, " ")}` : ""} · ${cu.tz} · consent ${c.consent_ok === null ? "unchecked" : c.consent_ok ? "ok" : "missing"} · hours ${c.hours_ok === null ? "unchecked" : c.hours_ok ? "ok" : "outside"}</p>
<div class="grid2"><div>
<div class="card"><h3>Transcript</h3><div class="transcript" id="transcript">${c.transcript.length ? c.transcript.map((t) => html`<div class="turn ${t.who}">${t.who === "customer" && t.quarantined?.length ? html`<span class="quarantined" title="quarantined: not shown to the brain">${t.quarantined.join(" ")}</span> ` : ""}${t.text}${t.tool ? html` <span class="pill info">${t.tool.replace(/_/g, " ")}</span>` : ""}</div>`) : html`<div class="empty">Not started.</div>`}</div>
${["planned", "blocked"].includes(c.status) ? html`<form method="post" action="/calls/${c.id}/place" class="callbar"><button class="btn primary" type="submit">${telephonyReady() ? "Place the call (phone)" : "Start in the simulator"}</button>${c.status === "blocked" ? html`<span class="small muted">Blocked calls are re-checked; if consent or hours still fail it stays blocked.</span>` : ""}</form><form method="post" action="/calls/${c.id}/skip" class="callbar"><input name="reason" placeholder="Skip because…" required><button class="btn" type="submit">Skip</button></form>` : ""}
${live ? html`<form method="post" action="/calls/${c.id}/say" class="stack"><label>Customer says<input name="text" id="say" autocomplete="off" placeholder="Type what the customer says…" required autofocus></label><div class="callbar"><button class="btn primary" type="submit">Send</button>${sample.map((s) => s.lines.slice(0, 2).map((l) => html`<button class="btn small" type="submit" name="text" value="${l}">${l.slice(0, 32)}${l.length > 32 ? "…" : ""}</button>`))}</div></form>
<form method="post" action="/calls/${c.id}/end" class="callbar"><button class="btn" type="submit">Hang up</button></form>
${realtimeReady() ? html`<div class="card"><h4>Live voice</h4><p class="small muted">Talk to the agent in your browser. The model speaks; every tool it calls comes back here through the same gate. <button class="btn" id="rt-start" data-call="${c.id}">Start live voice</button> <span id="rt-status" class="small muted"></span></p><audio id="rt-audio" autoplay></audio></div>` : html`<p class="small muted">Live voice needs OPENAI_API_KEY; the simulator above runs the same brain and gate.</p>`}` : ""}
</div>
<div class="card"><h3>Events</h3><ul class="feed">${events.map((e: any) => html`<li><span class="small muted">${fmtDate(e.at)}</span> ${e.summary}</li>`)}</ul></div></div>
<div><div class="card"><h3>The records the agent may speak from</h3>${o ? html`<table class="kv"><tr><th>Item</th><td>${o.title}</td></tr><tr><th>Amount</th><td>${money(o.amount_cents)}</td></tr><tr><th>Discount</th><td>${money(o.discount_cents)}</td></tr><tr><th>Balance</th><td><b>${money(o.kind === "class_cancel" ? o.settled_cents : balanceOf(o))}</b></td></tr><tr><th>Status</th><td>${pill(o.status)}</td></tr>${o.due_at ? html`<tr><th>Due</th><td>${fmtLocal(o.due_at, cu.tz)}</td></tr>` : ""}${o.appointment_at ? html`<tr><th>Appointment</th><td>${fmtLocal(o.appointment_at, cu.tz)}</td></tr>` : ""}</table>` : ""}
${opts ? html`<h4>Options the policy allows right now</h4><div class="options">${opts.discounts.map((d) => html`<div class="option"><code>${d.id}</code> ${d.label}</div>`)}${opts.plans.map((d) => html`<div class="option"><code>${d.id}</code> ${d.label}</div>`)}${!opts.discounts.length && !opts.plans.length ? html`<div class="muted small">No discount or plan options for this item.</div>` : ""}</div><p class="small muted">The brain picks an id; code computed every number above from the records and the policy.</p>` : ""}</div>
<div class="card"><h3>Trace</h3>${trace ? html`${renderTrace(trace.steps, { compact: true })}<p class="small"><a href="/trace/${c.run_id}">Full trace</a></p>` : html`<div class="muted small">No run yet.</div>`}</div></div></div>`;
    res.send(await ownerPage(req, p, `Call: ${cu.name}`, body, { scripts: live && realtimeReady() ? raw(`<script src="/static/call.js" defer></script>`) : undefined }));
  }));

  r.post("/calls/:id/place", act(async (req, res, p) => {
    const db = await getDb();
    await callById(db, req.params.id, p.business_id);
    const out = await placeCall(req.params.id, p.name);
    back(res, `/calls/${req.params.id}`, out.mode === "phone" ? `Dialling via Twilio (${out.providerCallId}).` : "Simulator call started.");
  }));
  r.post("/calls/:id/say", act(async (req, res, p) => {
    const db = await getDb();
    await callById(db, req.params.id, p.business_id);
    const text = String(req.body.text ?? "").slice(0, 1000);
    if (!text.trim()) throw new GtError("Say something first.", "empty");
    const out = await customerSays(db, req.params.id, text, p.name);
    back(res, `/calls/${req.params.id}`, out.ended ? `Call ended: ${out.outcome ?? "done"}.` : out.tool_result ?? `Agent: ${out.say.slice(0, 80)}`);
  }));
  r.post("/calls/:id/end", act(async (req, res, p) => {
    const db = await getDb();
    const c = await callById(db, req.params.id, p.business_id);
    await endCall(db, c.id, null, p.name);
    back(res, `/calls/${c.id}`, "Call ended.");
  }));
  r.post("/calls/:id/skip", act(async (req, res, p) => {
    const db = await getDb();
    await callById(db, req.params.id, p.business_id);
    await skipCall(db, req.params.id, String(req.body.reason ?? "skipped").slice(0, 200), p.name);
    back(res, `/calls/${req.params.id}`, "Skipped.");
  }));

  /* ---------------- live voice (OpenAI Realtime) ---------------- */
  r.post("/voice/realtime/session/:id", json(async (req) => {
    const p = await requireOwner(req);
    const db = await getDb();
    const c = await callById(db, req.params.id, p.business_id);
    if (c.status !== "in_progress") throw new GtError("Start the call first.", "bad_state");
    const cu = await customerById(db, c.customer_id);
    const o = c.obligation_id ? await obligationById(db, c.obligation_id) : null;
    const opts = o ? await optionsFor(db, p.business_id, o) : { discounts: [], plans: [], balance: 0 };
    const pol = await activePolicy(p.business_id, db);
    const options = { discounts: opts.discounts.map((d) => ({ id: d.id, label: d.label })), plans: opts.plans.map((d) => ({ id: d.id, label: d.label })), slots: callbackSlots(await nowOf(db, p.business_id), cu.tz, pol.rules).map((s) => ({ id: s.id, label: s.label })) };
    const bal = o ? (o.kind === "class_cancel" ? o.settled_cents : balanceOf(o)) : 0;
    const instructions = realtimeInstructions({ business: p.business_name, customer_first_name: cu.name.split(" ")[0], purpose: c.purpose, item: o?.title ?? "your account", balance_text: money(bal), due_text: o?.due_at ? `due ${fmtLocal(o.due_at, cu.tz)}` : o?.appointment_at ? `on ${fmtLocal(o.appointment_at, cu.tz)}` : "", tone: "warm and brief", options });
    const secret = await mintClientSecret(instructions, realtimeTools(options));
    if (!secret) throw new GtError("Live voice is not configured (OPENAI_API_KEY).", "no_model", 503);
    await recordVoiceEvent("openai-realtime", c.id, "session", { model: secret.model, expires_at: secret.expires_at }, true);
    return { client_secret: secret.value, model: secret.model, expires_at: secret.expires_at };
  }));
  r.post("/calls/:id/tool", json(async (req) => {
    const p = await requireOwner(req);
    const db = await getDb();
    await callById(db, req.params.id, p.business_id);
    const name = String(req.body?.name ?? "");
    const args = (req.body?.arguments && typeof req.body.arguments === "object" ? req.body.arguments : {}) as Record<string, unknown>;
    const out = await executeRealtimeTool(db, req.params.id, name, args, typeof req.body?.transcript === "string" ? req.body.transcript.slice(0, 1000) : undefined);
    if ("error" in out) return { ok: false, error: out.error };
    return { ok: true, result: out.tool_result ?? "done", gate: out.gate, ended: out.ended, outcome: out.outcome, say: out.say || null };
  }));
  r.post("/calls/:id/speech", json(async (req) => {
    // The live model's own transcript of what the customer said, recorded as speech (no tool).
    const p = await requireOwner(req);
    const db = await getDb();
    const c = await callById(db, req.params.id, p.business_id);
    if (c.status !== "in_progress") return { ok: false };
    const text = String(req.body?.text ?? "").slice(0, 1000);
    if (!text.trim()) return { ok: false };
    const out = await customerSays(db, c.id, text, "realtime");
    return { ok: true, quarantined: out.decision.quarantined, say: out.say, ended: out.ended };
  }));

  /* ---------------- Twilio voice webhooks ---------------- */
  r.post("/webhooks/voice/twiml/:id", page(async (req, res) => {
    const ok = webhookAuthorised(fullUrl(req), req.body ?? {}, req.get("x-twilio-signature") ?? undefined, typeof req.query.s === "string" ? req.query.s : undefined);
    await recordVoiceEvent("twilio", req.params.id, "twiml", req.body ?? {}, ok);
    if (!ok) return res.status(403).type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
    res.type("text/xml").send(await openingTwiml(req.params.id));
  }));
  r.post("/webhooks/voice/gather/:id", page(async (req, res) => {
    const ok = webhookAuthorised(fullUrl(req), req.body ?? {}, req.get("x-twilio-signature") ?? undefined, typeof req.query.s === "string" ? req.query.s : undefined);
    if (!ok) {
      await recordVoiceEvent("twilio", req.params.id, "gather.rejected", req.body ?? {}, false);
      return res.status(403).type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
    }
    res.type("text/xml").send(await gatherTwiml(req.params.id, String(req.body?.SpeechResult ?? ""), req.body?.Confidence ? Number(req.body.Confidence) : null));
  }));
  r.post("/webhooks/voice/status/:id", page(async (req, res) => {
    const ok = webhookAuthorised(fullUrl(req), req.body ?? {}, req.get("x-twilio-signature") ?? undefined, typeof req.query.s === "string" ? req.query.s : undefined);
    await statusEvent(req.params.id, req.body ?? {}, ok);
    res.status(204).end();
  }));
  r.post("/webhooks/voice/events", page(async (req, res) => {
    // Generic voice-platform events (Vapi / Retell / Bland style): recorded, verified by shared secret, never acted on blindly.
    const ok = Boolean(req.query.s && req.query.s === process.env.VOICE_WEBHOOK_SECRET);
    await recordVoiceEvent(String(req.body?.provider ?? "voice-platform"), typeof req.body?.call_id === "string" ? req.body.call_id : null, String(req.body?.type ?? "event"), req.body ?? {}, ok);
    res.status(ok ? 204 : 202).end();
  }));
  r.get("/api/v1/calls/:id", json(async (req) => {
    const p = await requireOwner(req);
    const db = await getDb();
    const c = await callById(db, req.params.id, p.business_id);
    return { ...c, obligation: c.obligation_id ? await obligationById(db, c.obligation_id) : null };
  }));
  r.get("/api/v1/plan", json(async (req) => {
    const p: Me = await requireOwner(req);
    const db = await getDb();
    const { candidates } = await import("../services/planner.js");
    const cs = await candidates(db, p.business_id);
    return cs.map((c) => ({ purpose: c.purpose, customer: c.customer.name, item: c.obligation.title, balance_cents: balanceOf(c.obligation), callable: c.verdict.ok, reasons: c.verdict.reasons }));
  }));
  return r;
}

export { jsonBlock, obligationsOf };
