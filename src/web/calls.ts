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
import { balanceOf, owedToCustomer, callById, callsOf, customerById, customersOf, eventsOf, nowOf, obligationById, obligationsOf } from "../store.js";
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
import { icon } from "./icons.js";
import { messageFlag } from "./safetyui.js";

const fullUrl = (req: Request) => `${req.protocol}://${req.get("host")}${req.originalUrl}`;

export function callsRouter(): Router {
  const r = Router();

  r.get("/calls", authed(async (req, res, p) => {
    const db = await getDb();
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const calls = await callsOf(db, p.business_id, { status: status ? [status as any] : undefined, limit: 200 });
    const custs = new Map((await customersOf(db, p.business_id)).map((c) => [c.id, c]));
    const chip = (label: string, v: string) => html`<a class="chip ${v === status ? "on" : ""}" href="/calls${v ? `?status=${v}` : ""}">${label}</a>`;
    const av = (n?: string) => (n ?? "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
    res.send(await ownerPage(req, p, "Calls", html`<div class="page-head"><div><h1>Calls</h1><p>Every call Callback planned, made or refused to make, with its transcript.</p></div></div><div class="chips">${chip("All", "")}${chip("Ready", "planned")}${chip("Not calling", "blocked")}${chip("On the line", "in_progress")}${chip("Finished", "ended")}${chip("Skipped", "skipped")}</div>
${calls.length ? html`<div class="rows">${calls.map((c) => { const cu = custs.get(c.customer_id); return html`<a class="r" href="/calls/${c.id}"><span class="av ${c.status === "blocked" || c.status === "skipped" ? "muted" : ""}">${av(cu?.name)}</span><span><div class="t">${cu?.name}</div><div class="s">${purposeLabel[c.purpose]} · ${c.outcome ? String(c.outcome).replace(/_/g, " ") : c.reason}</div></span><span class="m">${c.collected_cents ? html`<span class="amt">${money(c.collected_cents)}</span>` : ""}${fmtDate(c.created_at)}</span><span class="act">${pill(c.status)}</span></a>`; })}</div>` : html`<div class="empty">No calls match.</div>`}`));
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
    const verify = (c as any).state?.verify_code as string | undefined;
    const check = (ok: boolean | null, yes: string, no: string, unk: string) => html`<li class="${ok === null ? "" : ok ? "ok" : "no"}">${raw(icon(ok === null ? "clock" : ok ? "checkCircle" : "alert"))}<span>${ok === null ? unk : ok ? yes : no}</span></li>`;
    const body = html`<p class="small"><a href="/calls">← All calls</a></p>
<div class="page-head"><div><h1>${cu.name}</h1><p>${purposeLabel[c.purpose]}${o ? html` · ${o.title}` : ""} · ${c.reason}</p></div><div class="row">${pill(c.status, c.status === "in_progress" ? "on the line" : undefined)}${c.outcome ? pill("ended", c.outcome.replace(/_/g, " ")) : ""}</div></div>
<div class="grid call-grid"><div class="stack">
<section class="card"><div class="spread"><h2>${live ? html`<span class="wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span> On the line` : "Conversation"}</h2>${verify ? html`<span class="small muted">Verify code said on this call <b class="mono">${verify}</b></span>` : ""}</div>
<div class="convo" id="transcript">${c.transcript.length ? c.transcript.map((t) => t.who === "customer" ? html`<div class="bubble cust">${t.quarantined?.length ? html`<span class="quarantined" title="Kept away from the agent's instructions">${t.quarantined.join(" ")}</span> ` : ""}${t.text}</div>${messageFlag(t.text, "Callback never moves money somewhere new because of what's said on a call. Refunds only go back to the account that paid.")}` : html`<div class="bubble agent">${t.text}${t.tool ? html`<span class="tool-chip">${raw(icon("zap"))}${t.tool.replace(/_/g, " ")}</span>` : ""}</div>`) : html`<div class="empty">This call hasn't started.</div>`}</div>
${["planned", "blocked"].includes(c.status) ? html`<form method="post" action="/calls/${c.id}/place" class="row" style="margin-top:1rem"><button class="btn primary lg" type="submit" name="mode" value="simulator">${raw(icon("phone"))}Start the call</button>${telephonyReady() ? html`<button class="btn" type="submit" name="mode" value="phone" onclick="return confirm('This dials the customer\'s real phone number through Twilio. Continue?')">Dial their real phone</button>` : ""}</form>${c.status === "blocked" ? html`<p class="small muted">Blocked calls are checked again when you start them; if consent or hours still fail, nothing rings.</p>` : ""}<details class="small" style="margin-top:.5rem"><summary>Skip this call</summary><form method="post" action="/calls/${c.id}/skip" class="row" style="margin-top:.5rem"><label class="sr" for="skipr">Reason</label><input id="skipr" name="reason" placeholder="Skip because…" required style="max-width:20rem"><button class="btn" type="submit">Skip</button></form></details>` : ""}
${live ? html`<form method="post" action="/calls/${c.id}/say" class="stack say-form"><label for="say">Speak as ${cu.name.split(" ")[0]}</label><div class="row"><input name="text" id="say" autocomplete="off" placeholder="Type what the customer says…" required autofocus style="flex:1"><button class="btn primary" type="submit">Send</button></div>${sample.length ? html`<div class="chips">${sample.map((s) => s.lines.slice(0, 2).map((l) => html`<button class="chip" type="submit" name="text" value="${l}" formnovalidate>${l.slice(0, 40)}${l.length > 40 ? "…" : ""}</button>`))}</div>` : ""}</form>
<div class="row" style="margin-top:.75rem"><form method="post" action="/calls/${c.id}/end" class="inline"><button class="btn danger" type="submit">Hang up</button></form>${realtimeReady() ? html`<button class="btn" type="button" id="rt-start" data-call="${c.id}">${raw(icon("mic"))}Talk with your voice</button><span id="rt-status" class="small muted" aria-live="polite"></span><audio id="rt-audio" autoplay></audio>` : ""}</div>` : ""}
</section>
${events.length ? html`<section class="card"><details><summary><b>What happened on this call</b> <span class="muted small">${events.length} event${events.length === 1 ? "" : "s"}</span></summary><ul class="feed">${events.map((e: any) => html`<li><span class="small muted">${fmtDate(e.at)}</span> ${e.summary}</li>`)}</ul></details></section>` : ""}
</div>
<div class="stack">
<section class="card"><h2>What Callback may say</h2><p class="sub muted">Every number comes from these records. The agent can't invent one.</p>${o ? html`<table class="kv"><tr><th>Item</th><td>${o.title}</td></tr><tr><th>Amount</th><td class="amt">${money(o.amount_cents)}</td></tr>${o.discount_cents ? html`<tr><th>Discount given</th><td class="amt">${money(o.discount_cents)}</td></tr>` : ""}${o.kind === "class_cancel" ? html`<tr><th>Customer paid</th><td class="amt">${money(o.settled_cents)}</td></tr><tr><th>Owed to the customer</th><td class="amt"><b>${money(owedToCustomer(o))}</b>${owedToCustomer(o) ? " as a refund or credit" : ""}</td></tr>` : html`<tr><th>Still to pay</th><td class="amt"><b>${money(balanceOf(o))}</b></td></tr>`}<tr><th>Status</th><td>${pill(o.status)}</td></tr>${o.due_at ? html`<tr><th>Due</th><td>${fmtLocal(o.due_at, cu.tz)}</td></tr>` : ""}${o.appointment_at ? html`<tr><th>Appointment</th><td>${fmtLocal(o.appointment_at, cu.tz)}</td></tr>` : ""}</table>` : html`<p class="muted">No money item on this call.</p>`}
${opts && (opts.discounts.length || opts.plans.length) ? html`<h3>Offers your policy allows</h3><ul class="offer-list">${opts.discounts.map((d) => html`<li>${raw(icon("ticket"))}${d.label}</li>`)}${opts.plans.map((d) => html`<li>${raw(icon("calendar"))}${d.label}</li>`)}</ul><p class="small muted">Anything beyond these waits for the owner.</p>` : ""}</section>
<section class="card"><h2>Checked before dialling</h2><ul class="checklist">${check(c.consent_ok, "Consent on file", "No consent: won't call", "Consent not checked yet")}${check(c.hours_ok, `Inside calling hours in ${cu.tz.split("/").pop()?.replace(/_/g, " ")}`, `Outside calling hours in ${cu.tz.split("/").pop()?.replace(/_/g, " ")}`, "Calling hours not checked yet")}${check(!cu.dnc, "Not on do-not-call", "On the do-not-call list", "")}</ul></section>
<section class="card"><details><summary><b>Trace</b> <span class="muted small">every step and check</span></summary>${trace ? html`${renderTrace(trace.steps, { compact: true })}<p class="small"><a href="/trace/${c.run_id}">Open the full trace</a></p>` : html`<p class="muted small">No run yet.</p>`}</details></section>
</div></div>`;
    res.send(await ownerPage(req, p, `Call: ${cu.name}`, body, { scripts: live && realtimeReady() ? raw(`<script src="/static/call.js" defer></script>`) : undefined }));
  }));

  r.post("/calls/:id/place", act(async (req, res, p) => {
    const db = await getDb();
    await callById(db, req.params.id, p.business_id);
    const out = await placeCall(req.params.id, p.name, req.body.mode === "simulator" ? "simulator" : null);
    back(res, `/calls/${req.params.id}`, out.mode === "phone" ? `Dialling via Twilio (${out.providerCallId}).` : "Simulator call started.");
  }));
  r.post("/calls/:id/say", act(async (req, res, p) => {
    const db = await getDb();
    await callById(db, req.params.id, p.business_id);
    const text = String(req.body.text ?? "").slice(0, 1000);
    if (!text.trim()) throw new GtError("Say something first.", "empty");
    const out = await customerSays(db, req.params.id, text, p.name);
    if (out.ended || out.tool_result) return back(res, `/calls/${req.params.id}#say`, out.ended ? `Call ended: ${String(out.outcome ?? "done").replace(/_/g, " ")}.` : String(out.tool_result));
    res.redirect(303, `/calls/${req.params.id}#say`);
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
