/**
 * After the owner approves a held move. If the call that asked for it is still on the line, the agent retries on its
 * next turn and the gate lets the exact approved payload through. If the call is over, nobody would retry, so the
 * approved move is carried out here, through the same money service and the same gate (which matches the approval by
 * payload hash). If the records changed since the hold (a different balance, a discount withdrawn), nothing is sent and
 * the owner is told why: an approval is for one exact amount.
 */
import { getDb } from "../db.js";
import { startRun } from "../trace.js";
import { balanceOf, bizById, callById, customerById, logEvent, obligationById } from "../store.js";
import { applyDiscount, createInvoice, createPlan, optionsFor, sendPayLink, settleCancelledClass, type Ctx } from "./money.js";

export interface CarryOut {
  done: boolean;
  message: string;
}

export async function carryOutApproved(payload: any, by: string): Promise<CarryOut> {
  const db = await getDb();
  const scope = String(payload.agentScope ?? "");
  const callId = scope.startsWith("agent:") ? scope.slice(6) : null;
  const call = callId ? await callById(db, callId).catch(() => null) : null;
  if (call && ["in_progress", "ringing"].includes(call.status)) return { done: false, message: "The call is still on the line; Callback does it on its next turn." };
  const obligationId = payload.entity === "obligation" ? String(payload.entityId) : call?.obligation_id ?? null;
  if (!obligationId) return { done: false, message: "Nothing to carry out: the held move had no item." };
  const o = await obligationById(db, obligationId);
  const customer = await customerById(db, o.customer_id);
  const biz = await bizById(db, o.business_id);
  const run = await startRun({ actor: "owner", subject: `Carry out the approved ${payload.action} for ${customer.name}`, entity: "obligation", entityId: o.id }, db);
  const ctx: Ctx = { q: db, run, businessId: biz.id, businessName: biz.name, callId: call?.id ?? null, agentScope: scope || "owner" };
  const cents = Number(payload.cents ?? 0);
  try {
    let message: string;
    if (payload.action === "charge") {
      if (balanceOf(o) !== cents) throw new Changed(`the balance is now $${(balanceOf(o) / 100).toFixed(2)}, not the $${(cents / 100).toFixed(2)} you approved`);
      const r = await sendPayLink(ctx, o, customer);
      message = `PayPal link for $${(r.cents / 100).toFixed(2)} sent to ${customer.name}.`;
    } else if (payload.action === "invoice") {
      if (balanceOf(o) !== cents) throw new Changed(`the balance is now $${(balanceOf(o) / 100).toFixed(2)}, not the $${(cents / 100).toFixed(2)} you approved`);
      const r = await createInvoice(ctx, o, customer);
      message = `PayPal invoice ${r.paypalInvoiceId} for $${(r.cents / 100).toFixed(2)} sent to ${customer.name}.`;
    } else if (payload.action === "refund") {
      if (o.settled_cents !== cents) throw new Changed(`the amount paid is now $${(o.settled_cents / 100).toFixed(2)}`);
      const r = await settleCancelledClass(ctx, o, "refund");
      message = r.refundId ? `Refund of $${(r.cents / 100).toFixed(2)} sent back to ${customer.name}'s PayPal payment (${r.refundId}).` : `Refund of $${(r.cents / 100).toFixed(2)} recorded for you to pay back by hand (paid outside PayPal).`;
    } else if (payload.action === "plan") {
      const { plans } = await optionsFor(db, biz.id, o);
      const opt = plans.find((p) => p.instalments === Number(payload.instalments));
      if (!opt) throw new Changed("that plan is no longer one your policy allows for this balance");
      await createPlan(ctx, o, customer, opt.id);
      message = `Payment plan (${opt.label}) sent to ${customer.name} to approve on PayPal.`;
    } else if (payload.action === "discount") {
      const { discounts } = await optionsFor(db, biz.id, o);
      const step = discounts.find((d) => d.pct === Number(payload.discountPct));
      if (!step) throw new Changed("that discount is no longer available on this item");
      await applyDiscount(ctx, o, step.id);
      message = `${step.pct}% off applied for ${customer.name}. Send them a link from their call to collect the rest.`;
    } else return { done: false, message: `Approved. No automatic follow-up for ${String(payload.action)}.` };
    await run.end("done");
    await logEvent(db, { businessId: biz.id, customerId: customer.id, callId: call?.id ?? null, type: "approval.carried_out", summary: message, actor: by });
    return { done: true, message };
  } catch (e) {
    await run.end("failed");
    const why = e instanceof Changed ? `Nothing was sent: ${e.message}. Callback will plan a new call.` : `Approved, but PayPal did not complete it: ${(e as Error).message.slice(0, 140)}. Nothing was charged.`;
    await logEvent(db, { businessId: biz.id, customerId: customer.id, callId: call?.id ?? null, type: "approval.not_carried_out", summary: why, actor: by });
    return { done: false, message: why };
  }
}

class Changed extends Error {}
