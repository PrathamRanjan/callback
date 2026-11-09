/**
 * Call lifecycle (roadmap E.4). startCall re-checks consent, hours and the kill switch in code and opens the run;
 * customerSays records the customer's line as untrusted speech, asks the brain for the next line and at most one
 * tool, and executes that tool through the money services (every one of which passes the gate). A hold or a denial
 * becomes a spoken line ("I'll need the owner to confirm that") and a trace step, never a silent failure.
 */
import { decide, OUTCOMES, TOOLS, type BrainContext, type Decision, type Outcome, type Tool } from "../ai/agent.js";
import { quarantine } from "../ai/grounding.js";
import { config } from "../config.js";
import { callbackSlots } from "../core/plans.js";
import { mayCall } from "../core/consent.js";
import { fmtLocal } from "../core/time.js";
import type { Queryable } from "../db.js";
import { appendAudit } from "../guard/audit.js";
import { GateDenied, HeldForApproval } from "../guard/dryrun.js";
import { isKilled } from "../guard/kill.js";
import { activePolicy } from "../guard/policy.js";
import { register } from "../guard/provenance.js";
import { newId } from "../lib/ids.js";
import { GtError } from "../lib/util.js";
import { balanceOf, bizById, callAttempts, callById, customerById, logEvent, nowOf, obligationById, type Call, type Customer, type Obligation, type Turn } from "../store.js";
import { resumeRun, startRun, type Run } from "../trace.js";
import { applyDiscount, createInvoice, createPlan, optionsFor, sendPayLink, settleCancelledClass, type Ctx } from "./money.js";

const first = (name: string) => name.split(/\s+/)[0].replace(/[(),]/g, "");

export async function startCall(q: Queryable, callId: string, mode: Call["mode"], by: string, opts: { persona?: string | null; force?: boolean } = {}): Promise<{ call: Call; run: Run; opening: string }> {
  const call = await callById(q, callId);
  if (!["planned", "blocked"].includes(call.status)) throw new GtError(`Call is ${call.status}.`, "bad_state");
  const customer = await customerById(q, call.customer_id);
  const now = await nowOf(q, call.business_id);
  const pol = await activePolicy(call.business_id, q);
  const killed = (await isKilled("calls", q)) ?? (await isKilled(`purpose:${call.purpose}`, q));
  const verdict = mayCall({ id: customer.id, tz: customer.tz, consent: customer.consent, dnc: customer.dnc }, call.purpose, pol.rules, now, await callAttempts(q, customer.id, now));
  const run = await startRun({ actor: "agent", agentId: `callback:${mode}`, subject: `${call.purpose.replace(/_/g, " ")}: ${customer.name}`, entity: "call", entityId: call.id }, q);
  await run.step({ actor: "policy", tool: "consent.check", args: { customer: customer.name, tz: customer.tz, purpose: call.purpose, at: now.toISOString() }, policy: verdict.ok ? null : verdict.consent_ok ? "hours" : "consent", gate: verdict.ok ? "allowed" : "denied", result: verdict });
  if (killed?.engaged) {
    await run.step({ actor: "guard", tool: "kill.check", policy: `kill:${killed.scope}`, gate: "denied", result: { reason: killed.reason } });
    await run.end("failed");
    await q.query("UPDATE calls SET status = 'blocked', reason = $2, run_id = $3 WHERE id = $1", [call.id, `kill switch on ${killed.scope}`, run.id]);
    throw new GtError(`Calls are stopped by the kill switch on ${killed.scope}.`, "killed");
  }
  // Eval mode may run a blocked call to measure the policy; a real call never may.
  if (!verdict.ok && !(mode === "eval" && opts.force)) {
    await run.end("failed");
    await q.query("UPDATE calls SET status = 'blocked', reason = $2, run_id = $3, consent_ok = $4, hours_ok = $5 WHERE id = $1", [call.id, verdict.reasons.join("; "), run.id, verdict.consent_ok, verdict.hours_ok]);
    throw new GtError(`Not calling ${customer.name}: ${verdict.reasons.join("; ")}.`, "not_callable");
  }
  const ctx = await brainContext(q, call, customer, 0, []);
  const d = await decide(ctx, run.id);
  const opening: Turn = { who: "agent", text: d.say, at: new Date().toISOString(), tool: null };
  await run.step({ actor: d.brain === "model" ? "model" : "code", tool: `brain.${d.brain}`, args: { turn: 0 }, result: { say: d.say, tool: d.tool, reason: d.reason } });
  await q.query("UPDATE calls SET status = 'in_progress', mode = $2, persona = $3, started_at = now(), run_id = $4, attempts = attempts + 1, transcript = $5, state = $6, consent_ok = $7, hours_ok = $8 WHERE id = $1", [call.id, mode, opts.persona ?? null, run.id, JSON.stringify([opening]), JSON.stringify({ turns: 0, brain: d.brain }), verdict.consent_ok, verdict.hours_ok]);
  await logEvent(q, { businessId: call.business_id, customerId: customer.id, callId: call.id, type: "call.started", summary: `${mode} call to ${customer.name} started`, actor: by });
  await appendAudit("call.started", "call", call.id, { mode, by, consent: verdict.consent_ok, hours: verdict.hours_ok }, q);
  return { call: await callById(q, call.id), run, opening: d.say };
}

async function brainContext(q: Queryable, call: Call, customer: Customer, turn: number, transcript: Turn[]): Promise<BrainContext> {
  const biz = await bizById(q, call.business_id);
  const o = call.obligation_id ? await obligationById(q, call.obligation_id) : null;
  const pol = await activePolicy(call.business_id, q);
  const now = await nowOf(q, call.business_id);
  const opts = o ? await optionsFor(q, call.business_id, o) : { balance: 0, plans: [], discounts: [], rules: pol.rules };
  const bal = o ? (o.kind === "class_cancel" ? o.settled_cents : balanceOf(o)) : 0;
  const due = o?.kind === "deposit" && o.appointment_at ? `${o.due_at ? `due ${fmtLocal(o.due_at, customer.tz)}, ` : ""}for your appointment on ${fmtLocal(o.appointment_at, customer.tz)}` : o?.kind === "invoice" && o.due_at ? `due ${fmtLocal(o.due_at, customer.tz)}` : o?.appointment_at ? `scheduled ${fmtLocal(o.appointment_at, customer.tz)}` : "";
  const s = call.state;
  const tone = /warm|friendly|gentle|polite|brief/i.exec(pol.text)?.[0] ?? "warm and brief";
  return {
    business: biz.name,
    customer_first_name: first(customer.name),
    purpose: call.purpose,
    item: o?.title ?? "your account",
    balance_text: `$${(bal / 100).toFixed(2)}`,
    due_text: due,
    tone,
    turn,
    done: { link_sent: Boolean(s.link_sent), invoice_sent: Boolean(s.invoice_sent), discount_applied: Boolean(s.discount_pct), plan_sent: Boolean(s.plan_id), callback_set: Boolean(s.callback_at), settled: Boolean(s.closed) },
    options: {
      discounts: opts.discounts.map((d) => ({ id: d.id, label: d.label })),
      plans: opts.plans.map((p) => ({ id: p.id, label: p.label })),
      slots: callbackSlots(now, customer.tz, pol.rules).map((x) => ({ id: x.id, label: x.label })),
    },
    transcript: transcript.filter((t) => t.who !== "system").map((t) => ({ who: t.who as "agent" | "customer", text: t.text })),
    last_customer_line: [...transcript].reverse().find((t) => t.who === "customer")?.text ?? null,
  };
}

export interface TurnResult {
  say: string;
  tool: Tool;
  tool_result: string | null;
  ended: boolean;
  outcome: Outcome | null;
  decision: Decision;
  gate: "allowed" | "held" | "denied" | "n/a";
}

/** The customer said something. Returns what the agent says back (and did). */
export async function customerSays(q: Queryable, callId: string, rawText: string, by = "customer"): Promise<TurnResult> {
  const call = await callById(q, callId);
  if (call.status !== "in_progress") throw new GtError(`Call is ${call.status}.`, "bad_state");
  // Realtime path: a function call from the live model arrives as a marker line; the tool is forced, the speech (if any) is recorded.
  let forced: { tool: Tool; option_id: string | null; outcome: Outcome | null } | null = null;
  let text = rawText;
  const fm = /^\u0001tool:([a-z_]+):([^:\u0001]*):([^\u0001]*)\u0001([\s\S]*)$/.exec(rawText);
  if (fm) {
    forced = { tool: (TOOLS as readonly string[]).includes(fm[1]) ? (fm[1] as Tool) : "none", option_id: fm[2] || null, outcome: fm[3] && (OUTCOMES as readonly string[]).includes(fm[3]) ? (fm[3] as Outcome) : null };
    text = fm[4] || "(live voice: tool call)";
  }
  const customer = await customerById(q, call.customer_id);
  const run = await resumeRun(call.run_id!, q);
  const qn = quarantine(text);
  await register(`call:${call.id}`, "speech", text, "obligation", call.obligation_id ?? call.id, q);
  const transcript: Turn[] = [...call.transcript, { who: "customer", text: text.slice(0, 1000), at: new Date().toISOString(), quarantined: qn.quarantined }];
  const turn = (call.state.turns ?? 0) + 1;
  await run.step({ actor: "customer", tool: "speech", args: { turn, text: text.slice(0, 300) }, policy: qn.quarantined.length ? "quarantine" : null, gate: "n/a", result: { quarantined: qn.quarantined, money_mentions: qn.money_mentions } });
  if (qn.quarantined.length) await logEvent(q, { businessId: call.business_id, customerId: customer.id, callId: call.id, type: "speech.quarantined", summary: `Instruction-shaped line quarantined: "${qn.quarantined[0].slice(0, 80)}"`, actor: "guard" });

  const ctx = await brainContext(q, call, customer, turn, transcript);
  const d: Decision = forced ? { say: "", tool: forced.tool, option_id: forced.option_id, outcome: forced.outcome, reason: "realtime function call", brain: "model", quarantined: qn.quarantined } : await decide(ctx, run.id);
  await run.step({ actor: d.brain === "model" ? "model" : "code", tool: forced ? "brain.realtime" : `brain.${d.brain}`, args: { turn }, result: { say: d.say, tool: d.tool, option_id: d.option_id, outcome: d.outcome, reason: d.reason, model: d.model ?? null } });

  const state = { ...call.state, turns: turn, brain: d.brain };
  let say = d.say;
  let toolResult: string | null = null;
  let gate: TurnResult["gate"] = "n/a";
  let ended = false;
  let outcome: Outcome | null = d.outcome;
  const o = call.obligation_id ? await obligationById(q, call.obligation_id) : null;
  const ctxMoney: Ctx = { q, run, businessId: call.business_id, businessName: ctx.business, callId: call.id, agentScope: `agent:${call.id}` };
  const bizName = ctx.business;
  try {
    if (d.tool === "send_pay_link" && o) {
      if (!state.link_sent) {
        const r = await sendPayLink(ctxMoney, o, customer);
        state.link_sent = true;
        toolResult = `Pay link for $${(r.cents / 100).toFixed(2)} texted`;
      }
      gate = "allowed";
    } else if (d.tool === "create_invoice" && o) {
      if (!state.invoice_sent) {
        const r = await createInvoice(ctxMoney, o, customer);
        state.invoice_sent = true;
        toolResult = `Invoice ${r.paypalInvoiceId} for $${(r.cents / 100).toFixed(2)} sent`;
      }
      gate = "allowed";
      outcome = outcome ?? "invoice_sent";
    } else if (d.tool === "apply_discount" && o && d.option_id) {
      const r = await applyDiscount(ctxMoney, o, d.option_id);
      state.discount_pct = r.pct;
      toolResult = `${r.pct}% applied; balance now $${(r.newBalance / 100).toFixed(2)}`;
      gate = "allowed";
      say = say.replace(/\$\d+(\.\d{2})?/g, (m) => m); // the brain was handed the label; amounts in the label came from code
    } else if (d.tool === "create_plan" && o && d.option_id) {
      const r = await createPlan(ctxMoney, o, customer, d.option_id);
      state.plan_id = r.planRowId;
      toolResult = `Plan (${r.option.label}) texted for approval`;
      gate = "allowed";
      outcome = outcome ?? "plan_agreed";
    } else if ((d.tool === "settle_credit" || d.tool === "settle_refund") && o) {
      const r = await settleCancelledClass(ctxMoney, o, d.tool === "settle_refund" ? "refund" : "credit");
      state.closed = true;
      toolResult = `${r.choice} of $${(r.cents / 100).toFixed(2)}${r.refundId ? ` (${r.refundId})` : ""}`;
      gate = "allowed";
      outcome = outcome ?? (d.tool === "settle_refund" ? "refund" : "credit");
    } else if (d.tool === "schedule_callback" && d.option_id) {
      const now = await nowOf(q, call.business_id);
      const pol = await activePolicy(call.business_id, q);
      const slot = callbackSlots(now, customer.tz, pol.rules).find((s) => s.id === d.option_id);
      if (slot) {
        await q.query("INSERT INTO callbacks (id, business_id, call_id, customer_id, at) VALUES ($1,$2,$3,$4,$5)", [newId("cbk"), call.business_id, call.id, customer.id, slot.at]);
        state.callback_at = slot.at;
        toolResult = `Callback booked ${slot.label}`;
        await run.step({ actor: "code", tool: "callback.schedule", args: { at: slot.at }, gate: "allowed", result: { label: slot.label } });
        ended = true;
        outcome = "callback";
      }
    } else if (d.tool === "end_call") {
      ended = true;
      if (outcome === "do_not_call") {
        await q.query("UPDATE customers SET dnc = true, consent = jsonb_set(coalesce(consent, '{}'::jsonb), '{revoked_at}', to_jsonb(now()::text)) WHERE id = $1", [customer.id]);
        await appendAudit("consent.revoked", "customer", customer.id, { by: "customer on call", call: call.id }, q);
        await run.step({ actor: "code", tool: "consent.revoke", gate: "allowed", result: { dnc: true } });
      }
    }
  } catch (e) {
    if (e instanceof HeldForApproval) {
      gate = "held";
      toolResult = `Held for the owner: ${e.message}`;
      say = `I'll need ${bizName}'s owner to confirm that; they'll be in touch shortly, and nothing has been charged. ` + (d.tool === "apply_discount" ? "Meanwhile the original amount stands." : "");
    } else if (e instanceof GateDenied) {
      gate = "denied";
      toolResult = `Refused by the guard: ${e.message}`;
      say = d.tool === "apply_discount" ? `I'm not able to go that far; what I can offer is in the options I gave you.` : `I can't do that from here. ${nextLine(ctx)}`;
      await q.query("UPDATE calls SET breaches = breaches + 1 WHERE id = $1", [call.id]);
    } else if (e instanceof GtError) {
      gate = "denied";
      toolResult = e.message;
      say = `I couldn't do that just now. ${nextLine(ctx)}`;
    } else {
      gate = "denied";
      toolResult = `PayPal error: ${(e as Error).message.slice(0, 120)}`;
      say = "PayPal is slow to respond just now; nothing has been charged. I'll have the office send the link shortly.";
      await run.step({ actor: "paypal", tool: "error", result: { error: (e as Error).message.slice(0, 300) } });
    }
  }
  if (say || !forced) transcript.push({ who: "agent", text: say, at: new Date().toISOString(), tool: d.tool === "none" ? null : d.tool });
  if (toolResult) transcript.push({ who: "system", text: toolResult, at: new Date().toISOString() });
  await q.query("UPDATE calls SET transcript = $2, state = $3 WHERE id = $1", [call.id, JSON.stringify(transcript), JSON.stringify(state)]);
  if (ended || turn >= 14) await endCall(q, call.id, outcome ?? (turn >= 14 ? "callback" : deriveOutcome(state, o, gate === "held" ? 1 : 0)), by);
  return { say, tool: d.tool, tool_result: toolResult, ended: ended || turn >= 14, outcome, decision: d, gate };
}

/** The outcome a call's state implies when nobody named one. */
export function deriveOutcome(state: Call["state"], o: Obligation | null, held = 0): Outcome | "held" {
  if (state.plan_id) return "plan_agreed";
  if (state.link_sent) return "paid_link";
  if (state.invoice_sent) return "invoice_sent";
  if (state.closed && o) return o.status === "refunded" ? "refund" : o.status === "credited" ? "credit" : "declined";
  if (state.callback_at) return "callback";
  if (held > 0) return "held";
  return "declined";
}

const nextLine = (ctx: BrainContext) => (ctx.purpose === "cancel_class" ? "Would you like a credit or a refund?" : `I can text a PayPal link for ${ctx.balance_text}, or send an invoice. Which suits?`);

export async function endCall(q: Queryable, callId: string, outcome: Outcome | string | null, by: string) {
  const call = await callById(q, callId);
  if (call.status === "ended") return;
  const run = call.run_id ? await resumeRun(call.run_id, q) : null;
  const o = call.obligation_id ? await obligationById(q, call.obligation_id) : null;
  outcome = outcome ?? deriveOutcome(call.state, o);
  // A discount offered on the call is conditional on paying on the call. If no link, invoice or plan went out, it is withdrawn.
  let discountCents = o?.discount_cents ?? 0;
  const s = call.state;
  if (o && discountCents > 0 && s.discount_pct && !(s.link_sent || s.invoice_sent || s.plan_id)) {
    await q.query("UPDATE obligations SET discount_cents = 0 WHERE id = $1", [o.id]);
    await logEvent(q, { businessId: call.business_id, customerId: call.customer_id, callId: call.id, type: "discount.withdrawn", summary: `${s.discount_pct}% discount withdrawn: the call ended without a payment link, invoice or plan`, actor: by });
    await appendAudit("money.discount_withdrawn", "obligation", o.id, { pct: s.discount_pct, offCents: discountCents, by }, q);
    discountCents = 0;
  }
  await q.query("UPDATE calls SET status = 'ended', ended_at = now(), outcome = $2, discount_cents = $3 WHERE id = $1", [call.id, outcome, discountCents]);
  if (run) {
    await run.step({ actor: "code", tool: "call.end", result: { outcome, turns: call.state.turns ?? 0 } });
    await run.end("done");
  }
  await logEvent(q, { businessId: call.business_id, customerId: call.customer_id, callId: call.id, type: "call.ended", summary: `Call ended: ${String(outcome).replace(/_/g, " ")}`, actor: by });
  await appendAudit("call.ended", "call", call.id, { outcome, turns: call.state.turns ?? 0, by }, q);
}

export async function skipCall(q: Queryable, callId: string, reason: string, by: string) {
  await q.query("UPDATE calls SET status = 'skipped', reason = $2, ended_at = now() WHERE id = $1 AND status IN ('planned','blocked')", [callId, reason]);
  const c = await callById(q, callId);
  await logEvent(q, { businessId: c.business_id, customerId: c.customer_id, callId: c.id, type: "call.skipped", summary: `Skipped: ${reason}`, actor: by });
}

/** A transcript line for pages and TwiML. */
export function speakable(text: string): string {
  return text.replace(/https?:\/\/\S+/g, "the link I've just texted you").replace(/\s+/g, " ").trim();
}

export const demoLinkFor = (customer: Customer) => `${config.appUrl}/c/${customer.token}`;
export type { Obligation };
