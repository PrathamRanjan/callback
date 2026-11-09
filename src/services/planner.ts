/**
 * Call planner (roadmap E.4). From the business's records and PayPal state it decides which calls to make today and
 * why: a deposit due before tomorrow's appointment and not yet paid, an invoice overdue past the policy's grace, a
 * cancelled class whose customer must choose credit or refund. Every candidate passes consent and calling hours in
 * code; blocked calls are kept with the reason so the owner sees what was *not* done and why.
 */
import type { Queryable } from "../db.js";
import { mayCall, type Verdict } from "../core/consent.js";
import { activePolicy } from "../guard/policy.js";
import { isKilled } from "../guard/kill.js";
import { newId } from "../lib/ids.js";
import { balanceOf, callAttempts, customersOf, logEvent, nowOf, obligationsOf, type Call, type CallPurpose, type Customer, type Obligation } from "../store.js";
import { startRun } from "../trace.js";

export interface Candidate {
  purpose: CallPurpose;
  customer: Customer;
  obligation: Obligation;
  reason: string;
  verdict: Verdict;
}

const purposeOf = (o: Obligation): CallPurpose => (o.kind === "deposit" ? "confirm_deposit" : o.kind === "invoice" ? "chase_invoice" : "cancel_class");

export async function candidates(q: Queryable, businessId: string, now?: Date): Promise<Candidate[]> {
  const at = now ?? (await nowOf(q, businessId));
  const pol = await activePolicy(businessId, q);
  const custs = new Map((await customersOf(q, businessId)).map((c) => [c.id, c]));
  const out: Candidate[] = [];
  for (const o of await obligationsOf(q, businessId)) {
    const c = custs.get(o.customer_id);
    if (!c) continue;
    let reason: string | null = null;
    if (o.kind === "deposit" && ["open", "link_sent"].includes(o.status) && o.appointment_at && new Date(o.appointment_at).getTime() - at.getTime() < 36 * 3600_000 && balanceOf(o) > 0) reason = `deposit of $${(balanceOf(o) / 100).toFixed(2)} unpaid, appointment in ${Math.max(1, Math.round((new Date(o.appointment_at).getTime() - at.getTime()) / 3600_000))} h`;
    if (o.kind === "invoice" && ["open", "link_sent", "invoiced"].includes(o.status) && o.due_at && at.getTime() - new Date(o.due_at).getTime() > 7 * 86400_000 && balanceOf(o) > 0) reason = `$${(balanceOf(o) / 100).toFixed(2)} overdue by ${Math.floor((at.getTime() - new Date(o.due_at).getTime()) / 86400_000)} days`;
    if (o.kind === "class_cancel" && o.status === "open") reason = `class cancelled, $${(o.settled_cents / 100).toFixed(2)} paid: customer must choose credit or refund`;
    if (!reason) continue;
    const purpose = purposeOf(o);
    const hist = await callAttempts(q, c.id, at);
    const verdict = mayCall({ id: c.id, tz: c.tz, consent: c.consent, dnc: c.dnc }, purpose, pol.rules, at, hist);
    out.push({ purpose, customer: c, obligation: o, reason, verdict });
  }
  return out.sort((a, b) => Number(b.verdict.ok) - Number(a.verdict.ok) || (a.obligation.appointment_at ?? a.obligation.due_at ?? "").localeCompare(b.obligation.appointment_at ?? b.obligation.due_at ?? ""));
}

/** Writes today's plan: one planned or blocked call per candidate that has none open yet. Returns the calls touched. */
export async function planCalls(q: Queryable, businessId: string, by = "worker", now?: Date): Promise<{ planned: number; blocked: number; skipped: number; runId: string }> {
  const at = now ?? (await nowOf(q, businessId));
  const run = await startRun({ actor: "worker", subject: "Plan today's calls", entity: "business", entityId: businessId }, q);
  const killed = await isKilled("calls", q);
  const cands = await run.timed({ actor: "code", tool: "planner.candidates", args: { at: at.toISOString() } }, () => candidates(q, businessId, at), (cs) => cs.map((c) => ({ purpose: c.purpose, customer: c.customer.name, ok: c.verdict.ok, reasons: c.verdict.reasons })));
  let planned = 0;
  let blocked = 0;
  let skipped = 0;
  for (const c of cands) {
    const open = (await q.query<{ id: string; status: string }>("SELECT id, status FROM calls WHERE obligation_id = $1 AND status IN ('planned','blocked','ringing','in_progress')", [c.obligation.id])).rows[0];
    const pendingCallback = (await q.query("SELECT 1 FROM callbacks cb JOIN calls x ON x.id = cb.call_id WHERE x.obligation_id = $1 AND cb.status = 'scheduled'", [c.obligation.id])).rows.length > 0;
    if (!open && pendingCallback) {
      skipped++;
      continue;
    }
    const status = killed?.engaged ? "blocked" : c.verdict.ok ? "planned" : "blocked";
    const reason = killed?.engaged ? `kill switch on calls: ${killed.reason ?? ""}` : c.verdict.ok ? c.reason : `${c.reason}; not called: ${c.verdict.reasons.join("; ")}`;
    if (open) {
      // A call that is ringing or in progress is never re-planned: its own start would count as today's attempt.
      if (["ringing", "in_progress"].includes(open.status)) {
        skipped++;
        continue;
      }
      if (open.status !== status) await q.query("UPDATE calls SET status = $2, reason = $3, consent_ok = $4, hours_ok = $5, scheduled_at = $6 WHERE id = $1", [open.id, status, reason, c.verdict.consent_ok, c.verdict.hours_ok, c.verdict.next_window ?? at.toISOString()]);
      else skipped++;
      if (open.status !== status) status === "planned" ? planned++ : blocked++;
      continue;
    }
    const id = newId("call");
    const ins = await q.query("INSERT INTO calls (id, business_id, customer_id, obligation_id, purpose, status, reason, scheduled_at, consent_ok, hours_ok) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING", [id, businessId, c.customer.id, c.obligation.id, c.purpose, status, reason, c.verdict.next_window ?? at.toISOString(), c.verdict.consent_ok, c.verdict.hours_ok]);
    if (((ins as any).rowCount ?? (ins as any).affectedRows) === 0) {
      skipped++;
      continue;
    }
    await run.step({ actor: "policy", tool: status === "planned" ? "consent.allow" : "consent.block", args: { customer: c.customer.name, purpose: c.purpose }, policy: c.verdict.ok ? null : c.verdict.consent_ok ? "hours" : "consent", gate: c.verdict.ok ? "allowed" : "denied", result: { call: id, reasons: c.verdict.reasons, next_window: c.verdict.next_window } });
    await logEvent(q, { businessId, customerId: c.customer.id, callId: id, type: status === "planned" ? "call.planned" : "call.blocked", summary: `${c.purpose.replace(/_/g, " ")} for ${c.customer.name}: ${reason}`, actor: by });
    status === "planned" ? planned++ : blocked++;
  }
  await run.end("done");
  return { planned, blocked, skipped, runId: run.id };
}

export function describeCall(c: Call, customer: Customer, o: Obligation | null): string {
  const what = c.purpose === "confirm_deposit" ? `confirm the deposit for ${o?.title ?? "the appointment"}` : c.purpose === "chase_invoice" ? `settle ${o?.title ?? "the overdue invoice"}` : `choose credit or refund for ${o?.title ?? "the cancelled class"}`;
  return `Call ${customer.name} to ${what}.`;
}
