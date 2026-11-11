/**
 * Money moves the agent may ask for on a call. Each one: computes the amount from the records (never from speech),
 * passes the gate, writes a local row with a deterministic PayPal-Request-Id, calls PayPal, and records the result on
 * the trace. A lost response leaves the local row 'unknown' and the read_back job reconciles it.
 */
import { config } from "../config.js";
import type { Queryable } from "../db.js";
import { textCustomer } from "../channels/index.js";
import { discountSteps, instalmentOptions, type InstalmentOption } from "../core/plans.js";
import { appendAudit } from "../guard/audit.js";
import { gate, guardSettings } from "../guard/dryrun.js";
import { activePolicy } from "../guard/policy.js";
import { newId, requestKey } from "../lib/ids.js";
import { GtError } from "../lib/util.js";
import { paypal, toValue, UnknownOutcomeError } from "../paypal/index.js";
import { balanceOf, logEvent, obligationById, type Customer, type Obligation } from "../store.js";
import { noteRef, wsCustomId } from "./wsrefs.js";
import type { Run } from "../trace.js";

export interface Ctx {
  q: Queryable;
  run: Run;
  businessId: string;
  businessName: string;
  callId: string | null;
  agentScope: string;
  /** A person's own click (owner console, customer page). */
  personInitiated?: boolean;
}

/** Local rows in these states are retried (same PayPal-Request-Id, so PayPal returns the same resource if it did receive the first try). */
const RETRYABLE = new Set(["failed", "unknown", "creating"]);
const customerUrl = (c: Customer) => `${config.appUrl}/c/${c.token}`;

/** A PayPal order the customer approves from a link texted to them. Amount = balance after any applied discount. */
export async function sendPayLink(ctx: Ctx, o: Obligation, customer: Customer): Promise<{ payLinkId: string; approveUrl: string | null; cents: number }> {
  const cents = balanceOf(o);
  if (cents <= 0) throw new GtError("Nothing is owed on this item.", "nothing_owed");
  await gate({ action: "charge", agentScope: ctx.agentScope, entity: "obligation", entityId: o.id, businessId: ctx.businessId, cents, trustedCents: [cents], personInitiated: ctx.personInitiated }, ctx.run, ctx.q);
  const id = newId("pl");
  const requestId = requestKey("paylink", o.id, cents, o.discount_cents);
  const existing = (await ctx.q.query<{ id: string; approve_url: string | null; status: string }>("SELECT id, approve_url, status FROM pay_links WHERE request_id = $1", [requestId])).rows[0];
  if (existing && !RETRYABLE.has(existing.status)) return { payLinkId: existing.id, approveUrl: existing.approve_url, cents };
  if (existing) await ctx.q.query("DELETE FROM pay_links WHERE id = $1", [existing.id]); // retry with the same PayPal-Request-Id: idempotent at PayPal
  await ctx.q.query("INSERT INTO pay_links (id, business_id, obligation_id, call_id, amount_cents, status, request_id, run_id) VALUES ($1,$2,$3,$4,$5,'creating',$6,$7)", [id, ctx.businessId, o.id, ctx.callId, cents, requestId, ctx.run.id]);
  const pp = paypal();
  try {
    const order = await ctx.run.timed({ actor: "paypal", tool: "orders.create", args: { cents, customId: o.id }, pp_request_id: requestId }, () => pp.createOrder({ amountCents: cents, currency: config.currency, customId: wsCustomId(o.id), description: o.title.slice(0, 120), brand: ctx.businessName, returnUrl: `${customerUrl(customer)}?paid=1`, cancelUrl: customerUrl(customer) }, requestId), (r) => ({ id: r.id, status: r.status }));
    await noteRef("paypal.order", order.id);
    await ctx.q.query("UPDATE pay_links SET paypal_order_id = $2, approve_url = $3, status = 'sent' WHERE id = $1", [id, order.id, order.approveUrl]);
    await ctx.q.query("UPDATE obligations SET paypal_order_id = $2, status = CASE WHEN status IN ('open','link_sent') THEN 'link_sent' ELSE status END WHERE id = $1", [o.id, order.id]);
    await textCustomer(customer, `${ctx.businessName}: here is your secure PayPal link for ${o.title} ($${toValue(cents)}): ${order.approveUrl ?? customerUrl(customer)}`, "obligation", o.id, ctx.q);
    await logEvent(ctx.q, { businessId: ctx.businessId, customerId: customer.id, callId: ctx.callId, type: "paylink.sent", summary: `Pay link for $${toValue(cents)} sent to ${customer.name}`, actor: ctx.agentScope, data: { orderId: order.id } });
    await appendAudit("money.paylink", "obligation", o.id, { cents, orderId: order.id, by: ctx.agentScope }, ctx.q);
    return { payLinkId: id, approveUrl: order.approveUrl, cents };
  } catch (e) {
    await ctx.q.query("UPDATE pay_links SET status = $2 WHERE id = $1", [id, e instanceof UnknownOutcomeError ? "unknown" : "failed"]);
    throw e;
  }
}

/**
 * "Pay as the demo customer (saved PayPal, no login)" (spec A2.1). Demo only: the order is paid from the demo's saved
 * sandbox wallet (a Vault v3 payment token), so a judge sees real order and capture ids without a PayPal login. The
 * order call's own answer changes nothing; only the order read back from PayPal marks the item paid. `booking` pays
 * for a class the seed says was already paid for, so a later refund goes back to a real PayPal capture.
 */
export async function payFromDemoWallet(ctx: Ctx, o: Obligation, customer: Customer, opts: { booking?: boolean } = {}): Promise<{ orderId: string; captureId: string; cents: number }> {
  if (!config.demoMode) throw new GtError("The saved demo wallet only pays inside the demo.", "not_demo", 403);
  const vaultId = config.paypal.demoVaultToken;
  if (!vaultId) throw new GtError("The demo's saved PayPal wallet is not set up. Use “Pay on PayPal's own page” instead.", "no_wallet", 409);
  const cents = opts.booking ? o.settled_cents : balanceOf(o);
  if (cents <= 0) throw new GtError("Nothing is owed on this item.", "nothing_owed");
  if (opts.booking && o.capture_id) return { orderId: o.paypal_order_id ?? "", captureId: o.capture_id, cents };
  await gate({ action: "charge", agentScope: ctx.agentScope, entity: "obligation", entityId: o.id, businessId: ctx.businessId, cents, trustedCents: [cents], personInitiated: true }, ctx.run, ctx.q);
  const requestId = requestKey("wallet", o.id, cents, o.discount_cents, opts.booking ? "booking" : "balance");
  const existing = (await ctx.q.query<{ id: string; status: string; paypal_order_id: string | null }>("SELECT id, status, paypal_order_id FROM pay_links WHERE request_id = $1", [requestId])).rows[0];
  if (existing?.status === "paid" && existing.paypal_order_id) {
    const fresh = await obligationById(ctx.q, o.id);
    return { orderId: existing.paypal_order_id, captureId: fresh.capture_id ?? "", cents };
  }
  if (existing) await ctx.q.query("DELETE FROM pay_links WHERE id = $1", [existing.id]);
  const id = newId("pl");
  await ctx.q.query("INSERT INTO pay_links (id, business_id, obligation_id, call_id, amount_cents, status, request_id, run_id, via) VALUES ($1,$2,$3,$4,$5,'creating',$6,$7,'demo_wallet')", [id, ctx.businessId, o.id, ctx.callId, cents, requestId, ctx.run.id]);
  const pp = paypal();
  try {
    const created = await ctx.run.timed({ actor: "paypal", tool: "orders.create", args: { cents, customId: o.id, payment_source: "paypal.vault_id (saved demo wallet)" }, pp_request_id: requestId }, () => pp.createVaultOrder({ amountCents: cents, currency: config.currency, customId: wsCustomId(o.id), description: o.title.slice(0, 120), brand: ctx.businessName, vaultId }, requestId), (r) => ({ id: r.id, status: r.status }));
    await noteRef("paypal.order", created.id);
    // Read back: the order as PayPal holds it now decides what is recorded.
    const order = await ctx.run.timed({ actor: "paypal", tool: "orders.get", args: { orderId: created.id } }, () => pp.getOrder(created.id), (r) => ({ status: r.status, capture: r.purchase_units?.[0]?.payments?.captures?.[0]?.status ?? null }));
    const cap = order.purchase_units?.[0]?.payments?.captures?.[0];
    if (order.status !== "COMPLETED" || !cap || cap.status !== "COMPLETED") {
      await ctx.q.query("UPDATE pay_links SET paypal_order_id = $2, status = $3 WHERE id = $1", [id, created.id, `paypal_${String(cap?.status ?? order.status).toLowerCase()}`]);
      throw new GtError(`PayPal did not complete the payment (order ${created.id} is ${order.status}${cap ? `, capture ${cap.status}` : ""}). Nothing is marked paid.`, "not_completed", 502);
    }
    const paid = Math.round(Number(cap.amount.value) * 100);
    await noteRef("paypal.capture", cap.id);
    await ctx.q.query("UPDATE pay_links SET paypal_order_id = $2, status = 'paid' WHERE id = $1", [id, created.id]);
    if (opts.booking) await ctx.q.query("UPDATE obligations SET capture_id = $2, paypal_order_id = $3 WHERE id = $1", [o.id, cap.id, created.id]);
    else await ctx.q.query("UPDATE obligations SET status = 'paid', capture_id = $2, paypal_order_id = $3, settled_cents = settled_cents + $4 WHERE id = $1", [o.id, cap.id, created.id, paid]);
    await logEvent(ctx.q, { businessId: ctx.businessId, customerId: customer.id, callId: ctx.callId, type: "payment.captured", summary: `$${toValue(paid)} paid from the demo's saved sandbox wallet for ${o.title} (PayPal capture ${cap.id})`, actor: "paypal", data: { orderId: created.id, captureId: cap.id, via: "demo_wallet" } });
    await appendAudit("money.captured", "obligation", o.id, { captureId: cap.id, orderId: created.id, cents: paid, via: "demo_wallet" }, ctx.q);
    return { orderId: created.id, captureId: cap.id, cents: paid };
  } catch (e) {
    if (!(e instanceof GtError)) await ctx.q.query("UPDATE pay_links SET status = $2 WHERE id = $1", [id, e instanceof UnknownOutcomeError ? "unknown" : "failed"]);
    throw e;
  }
}

/** Invoicing v2: for a customer who wants to pay later or by bank, an invoice for the balance, sent by PayPal. */
export async function createInvoice(ctx: Ctx, o: Obligation, customer: Customer, dueDays = 7): Promise<{ invoiceId: string; paypalInvoiceId: string; href: string | null; cents: number }> {
  const cents = balanceOf(o);
  if (cents <= 0) throw new GtError("Nothing is owed on this item.", "nothing_owed");
  await gate({ action: "invoice", agentScope: ctx.agentScope, entity: "obligation", entityId: o.id, businessId: ctx.businessId, cents, trustedCents: [cents], personInitiated: ctx.personInitiated }, ctx.run, ctx.q);
  const requestId = requestKey("invoice", o.id, cents);
  const existing = (await ctx.q.query<any>("SELECT * FROM invoices WHERE request_id = $1", [requestId])).rows[0];
  if (existing && !RETRYABLE.has(existing.status)) return { invoiceId: existing.id, paypalInvoiceId: existing.paypal_invoice_id, href: existing.href, cents };
  if (existing) await ctx.q.query("DELETE FROM invoices WHERE id = $1", [existing.id]);
  const id = newId("inv");
  await ctx.q.query("INSERT INTO invoices (id, business_id, obligation_id, call_id, amount_cents, status, request_id, run_id) VALUES ($1,$2,$3,$4,$5,'creating',$6,$7)", [id, ctx.businessId, o.id, ctx.callId, cents, requestId, ctx.run.id]);
  const pp = paypal();
  try {
    const inv = await ctx.run.timed({ actor: "paypal", tool: "invoices.create", args: { cents, reference: o.id }, pp_request_id: requestId }, () => pp.createInvoice({ recipientEmail: customer.email || "customer@example.com", amountCents: cents, currency: config.currency, description: o.title, reference: wsCustomId(o.id), dueDays, businessName: ctx.businessName }, requestId), (r) => ({ id: r.id, status: r.status }));
    await ctx.run.timed({ actor: "paypal", tool: "invoices.send", args: { id: inv.id }, pp_request_id: requestId + "-send" }, () => pp.sendInvoice(inv.id, requestId + "-send"), () => ({ sent: true }));
    await noteRef("paypal.invoice", inv.id);
    await ctx.q.query("UPDATE invoices SET paypal_invoice_id = $2, href = $3, status = 'sent' WHERE id = $1", [id, inv.id, inv.href ?? null]);
    await ctx.q.query("UPDATE obligations SET paypal_invoice_id = $2, status = 'invoiced' WHERE id = $1", [o.id, inv.id]);
    await logEvent(ctx.q, { businessId: ctx.businessId, customerId: customer.id, callId: ctx.callId, type: "invoice.sent", summary: `PayPal invoice for $${toValue(cents)} sent to ${customer.name}, due in ${dueDays} days`, actor: ctx.agentScope, data: { invoiceId: inv.id } });
    await appendAudit("money.invoice", "obligation", o.id, { cents, invoiceId: inv.id, by: ctx.agentScope }, ctx.q);
    return { invoiceId: id, paypalInvoiceId: inv.id, href: inv.href ?? null, cents };
  } catch (e) {
    await ctx.q.query("UPDATE invoices SET status = $2 WHERE id = $1", [id, e instanceof UnknownOutcomeError ? "unknown" : "failed"]);
    throw e;
  }
}

/** The options the policy allows right now for this obligation; the brain picks an id from these, nothing else. */
export async function optionsFor(q: Queryable, businessId: string, o: Obligation) {
  const pol = await activePolicy(businessId, q);
  const settings = await guardSettings(businessId, q);
  const balance = balanceOf(o);
  return { balance, plans: o.kind === "class_cancel" ? [] : instalmentOptions(balance, pol.rules), discounts: o.kind === "invoice" && o.discount_cents === 0 ? discountSteps(balance, pol.rules, settings.auto_discount_max_pct) : [], rules: pol.rules };
}

/** Apply a discount step the brain picked (id from optionsFor). The percentage is checked against the policy by the gate. */
export async function applyDiscount(ctx: Ctx, o: Obligation, stepId: string): Promise<{ pct: number; offCents: number; newBalance: number }> {
  const { discounts } = await optionsFor(ctx.q, ctx.businessId, o);
  const step = discounts.find((d) => d.id === stepId);
  if (!step) throw new GtError(`Discount ${stepId} is not one the policy offers.`, "no_such_option");
  await gate({ action: "discount", agentScope: ctx.agentScope, entity: "obligation", entityId: o.id, businessId: ctx.businessId, cents: step.off_cents, trustedCents: [step.off_cents], discountPct: step.pct, personInitiated: ctx.personInitiated }, ctx.run, ctx.q);
  await ctx.q.query("UPDATE obligations SET discount_cents = $2 WHERE id = $1", [o.id, step.off_cents]);
  await logEvent(ctx.q, { businessId: ctx.businessId, customerId: o.customer_id, callId: ctx.callId, type: "discount.applied", summary: `${step.pct}% ($${toValue(step.off_cents)}) off ${o.title}`, actor: ctx.agentScope });
  await appendAudit("money.discount", "obligation", o.id, { pct: step.pct, offCents: step.off_cents, by: ctx.agentScope }, ctx.q);
  return { pct: step.pct, offCents: step.off_cents, newBalance: step.pay_cents };
}

/** Invoice states a customer may still split into a plan: nothing paid, no PayPal invoice or plan outstanding. */
export const SPLITTABLE = new Set(["open", "link_sent"]);

/** Instalment plan: product + plan + subscription with a fixed cycle count; the customer approves from a link. */
export async function createPlan(ctx: Ctx, o: Obligation, customer: Customer, optionId: string): Promise<{ planRowId: string; approveUrl: string | null; option: InstalmentOption }> {
  const { plans, balance } = await optionsFor(ctx.q, ctx.businessId, o);
  const option = plans.find((p) => p.id === optionId);
  if (!option) throw new GtError(`Plan ${optionId} is not one the policy offers.`, "no_such_option");
  await gate({ action: "plan", agentScope: ctx.agentScope, entity: "obligation", entityId: o.id, businessId: ctx.businessId, cents: balance, trustedCents: [balance], instalments: option.instalments, personInitiated: ctx.personInitiated }, ctx.run, ctx.q);
  const requestId = requestKey("plan", o.id, option.id, balance);
  const existing = (await ctx.q.query<any>("SELECT * FROM instalment_plans WHERE request_id = $1", [requestId])).rows[0];
  if (existing && !RETRYABLE.has(existing.status)) return { planRowId: existing.id, approveUrl: existing.approve_url, option };
  if (existing) await ctx.q.query("DELETE FROM instalment_plans WHERE id = $1", [existing.id]);
  const id = newId("ipl");
  await ctx.q.query("INSERT INTO instalment_plans (id, business_id, obligation_id, call_id, option, status, request_id, run_id) VALUES ($1,$2,$3,$4,$5,'creating',$6,$7)", [id, ctx.businessId, o.id, ctx.callId, JSON.stringify(option), requestId, ctx.run.id]);
  const pp = paypal();
  try {
    const product = await ctx.run.timed({ actor: "paypal", tool: "catalog.products.create", args: { name: o.title }, pp_request_id: requestId + "-prod" }, () => pp.createProduct(`${ctx.businessName}: ${o.title}`.slice(0, 120), requestId + "-prod"));
    const plan = await ctx.run.timed({ actor: "paypal", tool: "billing.plans.create", args: { per: option.per_cents, cycles: option.instalments }, pp_request_id: requestId + "-plan" }, () => pp.createPlan({ productId: product.id, name: `${option.instalments} payments for ${o.title}`.slice(0, 120), description: option.label, price: toValue(option.per_cents), currency: config.currency, intervalUnit: option.interval_unit, intervalCount: option.interval_count, totalCycles: option.instalments }, requestId + "-plan"), (r) => ({ id: r.id, status: r.status }));
    const sub = await ctx.run.timed({ actor: "paypal", tool: "billing.subscriptions.create", args: { planId: plan.id }, pp_request_id: requestId + "-sub" }, () => pp.createSubscription({ planId: plan.id, customId: wsCustomId(o.id), brandName: ctx.businessName, returnUrl: `${customerUrl(customer)}?plan=1`, cancelUrl: customerUrl(customer), subscriberEmail: customer.email || undefined, subscriberName: customer.name }, requestId + "-sub"), (r) => ({ id: r.id, status: r.status }));
    await noteRef("paypal.subscription", sub.id);
    await ctx.q.query("UPDATE instalment_plans SET paypal_plan_id = $2, subscription_id = $3, approve_url = $4, status = 'awaiting_approval' WHERE id = $1", [id, plan.id, sub.id, sub.approveUrl]);
    await ctx.q.query("UPDATE obligations SET subscription_id = $2, status = 'planned' WHERE id = $1", [o.id, sub.id]);
    await textCustomer(customer, `${ctx.businessName}: your payment plan (${option.label}) is ready to approve: ${sub.approveUrl ?? customerUrl(customer)}`, "obligation", o.id, ctx.q);
    await logEvent(ctx.q, { businessId: ctx.businessId, customerId: customer.id, callId: ctx.callId, type: "plan.sent", summary: `Instalment plan (${option.label}) sent to ${customer.name}`, actor: ctx.agentScope, data: { subscriptionId: sub.id } });
    await appendAudit("money.plan", "obligation", o.id, { option, subscriptionId: sub.id, by: ctx.agentScope }, ctx.q);
    return { planRowId: id, approveUrl: sub.approveUrl, option };
  } catch (e) {
    await ctx.q.query("UPDATE instalment_plans SET status = $2 WHERE id = $1", [id, e instanceof UnknownOutcomeError ? "unknown" : "failed"]);
    throw e;
  }
}

/** Cancelled class: refund what was paid (gate checks the live capture) or credit it to the account (no PayPal write). */
export async function settleCancelledClass(ctx: Ctx, o: Obligation, choice: "refund" | "credit"): Promise<{ choice: string; cents: number; refundId?: string }> {
  if (o.kind !== "class_cancel") throw new GtError("Not a cancelled class.", "wrong_kind");
  const cents = o.settled_cents;
  if (choice === "credit") {
    await ctx.q.query("UPDATE obligations SET status = 'credited' WHERE id = $1", [o.id]);
    await logEvent(ctx.q, { businessId: ctx.businessId, customerId: o.customer_id, callId: ctx.callId, type: "class.credited", summary: `$${toValue(cents)} credited to the account for ${o.title}`, actor: ctx.agentScope });
    await appendAudit("money.credit", "obligation", o.id, { cents, by: ctx.agentScope }, ctx.q);
    await ctx.run.step({ actor: "code", tool: "credit.apply", args: { cents }, gate: "n/a", result: { status: "credited" } });
    return { choice, cents };
  }
  await gate({ action: "refund", agentScope: ctx.agentScope, entity: "obligation", entityId: o.id, businessId: ctx.businessId, cents, trustedCents: [cents], paypal: { captureId: o.capture_id }, personInitiated: ctx.personInitiated }, ctx.run, ctx.q);
  const requestId = requestKey("refund", o.id, cents);
  const existing = (await ctx.q.query<any>("SELECT * FROM refunds WHERE request_id = $1", [requestId])).rows[0];
  if (existing && !RETRYABLE.has(existing.status)) return { choice, cents, refundId: existing.paypal_refund_id };
  if (existing) await ctx.q.query("DELETE FROM refunds WHERE id = $1", [existing.id]);
  const id = newId("rf");
  await ctx.q.query("INSERT INTO refunds (id, business_id, obligation_id, call_id, amount_cents, status, request_id, run_id) VALUES ($1,$2,$3,$4,$5,'creating',$6,$7)", [id, ctx.businessId, o.id, ctx.callId, cents, requestId, ctx.run.id]);
  if (!o.capture_id) {
    // Paid outside PayPal (seeded cash/transfer): record the refund as owed by hand, no PayPal write.
    await ctx.q.query("UPDATE refunds SET status = 'by_hand' WHERE id = $1", [id]);
    await ctx.q.query("UPDATE obligations SET status = 'refunded' WHERE id = $1", [o.id]);
    await ctx.run.step({ actor: "code", tool: "refund.by_hand", args: { cents }, gate: "allowed", result: { note: "no PayPal capture on file; refund recorded for the owner to pay by hand" } });
    await logEvent(ctx.q, { businessId: ctx.businessId, customerId: o.customer_id, callId: ctx.callId, type: "class.refund_by_hand", summary: `$${toValue(cents)} refund recorded for ${o.title} (paid outside PayPal)`, actor: ctx.agentScope });
    return { choice, cents };
  }
  const pp = paypal();
  try {
    const r = await ctx.run.timed({ actor: "paypal", tool: "payments.captures.refund", args: { captureId: o.capture_id, cents }, pp_request_id: requestId }, () => pp.refundCapture(o.capture_id!, cents, config.currency, `Cancelled: ${o.title}`.slice(0, 120), requestId), (x) => ({ id: x.id, status: x.status }));
    await noteRef("paypal.refund", r.id);
    await ctx.q.query("UPDATE refunds SET paypal_refund_id = $2, status = $3 WHERE id = $1", [id, r.id, r.status.toLowerCase()]);
    await ctx.q.query("UPDATE obligations SET status = 'refunded' WHERE id = $1", [o.id]);
    await logEvent(ctx.q, { businessId: ctx.businessId, customerId: o.customer_id, callId: ctx.callId, type: "class.refunded", summary: `$${toValue(cents)} refunded for ${o.title}`, actor: ctx.agentScope, data: { refundId: r.id } });
    await appendAudit("money.refund", "obligation", o.id, { cents, refundId: r.id, by: ctx.agentScope }, ctx.q);
    return { choice, cents, refundId: r.id };
  } catch (e) {
    await ctx.q.query("UPDATE refunds SET status = $2 WHERE id = $1", [id, e instanceof UnknownOutcomeError ? "unknown" : "failed"]);
    throw e;
  }
}

/** Read-back reconciliation: PayPal is the truth for what was paid. Returns how many obligations changed. */
export async function readBack(q: Queryable, businessId: string, run?: Run): Promise<number> {
  const pp = paypal();
  let changed = 0;
  const open = (await q.query<any>("SELECT * FROM obligations WHERE business_id = $1 AND status IN ('link_sent','invoiced','planned','open') AND (paypal_order_id IS NOT NULL OR paypal_invoice_id IS NOT NULL OR subscription_id IS NOT NULL)", [businessId])).rows;
  for (const row of open) {
    const o = await obligationById(q, row.id);
    try {
      if (o.paypal_order_id && o.status === "link_sent") {
        const order = await pp.getOrder(o.paypal_order_id);
        if (order.status === "APPROVED") {
          // The customer approved from the link: capture is the one PayPal write that follows a customer's own approval.
          const cap = await captureApproved(q, businessId, o, run);
          if (cap) changed++;
        } else if (order.status === "COMPLETED") {
          const cap = order.purchase_units?.[0]?.payments?.captures?.[0];
          if (cap) {
            await q.query("UPDATE obligations SET status = 'paid', capture_id = $2, settled_cents = settled_cents + $3 WHERE id = $1 AND status <> 'paid'", [o.id, cap.id, Math.round(Number(cap.amount.value) * 100)]);
            changed++;
          }
        }
      } else if (o.paypal_invoice_id && o.status === "invoiced") {
        const inv = await pp.getInvoice(o.paypal_invoice_id);
        if (["PAID", "MARKED_AS_PAID"].includes(inv.status)) {
          await q.query("UPDATE obligations SET status = 'paid', settled_cents = amount_cents - discount_cents WHERE id = $1", [o.id]);
          await q.query("UPDATE invoices SET status = 'paid' WHERE paypal_invoice_id = $1", [o.paypal_invoice_id]);
          changed++;
        }
      } else if (o.subscription_id && o.status === "planned") {
        const sub = await pp.getSubscription(o.subscription_id);
        if (sub.status === "ACTIVE") {
          await q.query("UPDATE instalment_plans SET status = 'active' WHERE subscription_id = $1 AND status <> 'active'", [o.subscription_id]);
          const done = sub.billing_info?.cycle_executions?.[0];
          if (done && done.total_cycles && done.cycles_completed >= done.total_cycles) {
            await q.query("UPDATE obligations SET status = 'paid', settled_cents = amount_cents - discount_cents WHERE id = $1", [o.id]);
            changed++;
          }
        } else if (sub.status === "CANCELLED") {
          await q.query("UPDATE instalment_plans SET status = 'cancelled' WHERE subscription_id = $1", [o.subscription_id]);
          await q.query("UPDATE obligations SET status = 'open', subscription_id = NULL WHERE id = $1", [o.id]);
          changed++;
        }
      }
    } catch (e) {
      if (run) await run.step({ actor: "paypal", tool: "read_back.error", args: { obligation: o.id }, result: { error: (e as Error).message.slice(0, 200) } });
    }
  }
  if (run) {
    const { readBackHolds } = await import("./holds.js");
    changed += await readBackHolds(q, businessId, run);
  }
  for (const pl of (await q.query<any>("SELECT * FROM pay_links WHERE business_id = $1 AND status = 'unknown'", [businessId])).rows) {
    // Lost response on createOrder: PayPal may hold an order; we cannot search orders by request id, so the link stays 'unknown' and the owner sees it.
    void pl;
  }
  return changed;
}

/** Capture an order the customer approved from their link. Gated like every other write; the customer's tap is the approval. */
async function captureApproved(q: Queryable, businessId: string, o: Obligation, run?: Run): Promise<boolean> {
  const { startRun } = await import("../trace.js");
  const r = run ?? (await startRun({ actor: "worker", subject: `Capture approved order for ${o.title}`, entity: "obligation", entityId: o.id }, q));
  const cents = balanceOf(o);
  await gate({ action: "charge", agentScope: "worker", entity: "obligation", entityId: o.id, businessId, cents, trustedCents: [cents], paypal: { orderId: o.paypal_order_id }, personInitiated: true }, r, q);
  const requestId = requestKey("capture", o.paypal_order_id!, cents);
  const pp = paypal();
  try {
    const order = await r.timed({ actor: "paypal", tool: "orders.capture", args: { orderId: o.paypal_order_id }, pp_request_id: requestId }, () => pp.captureOrder(o.paypal_order_id!, requestId), (x) => ({ status: x.status }));
    const cap = order.purchase_units?.[0]?.payments?.captures?.[0];
    if (cap) {
      await q.query("UPDATE obligations SET status = 'paid', capture_id = $2, settled_cents = settled_cents + $3 WHERE id = $1", [o.id, cap.id, Math.round(Number(cap.amount.value) * 100)]);
      await q.query("UPDATE pay_links SET status = 'paid' WHERE paypal_order_id = $1", [o.paypal_order_id]);
      await q.query("UPDATE calls SET collected_cents = collected_cents + $2 WHERE obligation_id = $1 AND status = 'ended' AND id = (SELECT id FROM calls WHERE obligation_id = $1 ORDER BY created_at DESC LIMIT 1)", [o.id, Math.round(Number(cap.amount.value) * 100)]);
      await logEvent(q, { businessId, customerId: o.customer_id, type: "payment.captured", summary: `$${cap.amount.value} captured for ${o.title}`, actor: "paypal", data: { captureId: cap.id } });
      await appendAudit("money.captured", "obligation", o.id, { captureId: cap.id, cents: Math.round(Number(cap.amount.value) * 100) }, q);
    }
    if (!run) await r.end("done");
    return Boolean(cap);
  } catch (e) {
    if (!run) await r.end("failed");
    throw e;
  }
}
