/**
 * A hold on the call for deposits (spec B2 item 3): "hold $60 now, charged only if you attend".
 * The hold is a PayPal Orders v2 order with intent AUTHORIZE. The customer approves it from a texted link (then the
 * worker authorizes the approved order) or, in the demo, from the saved sandbox wallet. After the appointment the owner
 * captures it ("Attended: charge"); after a timely cancel the owner voids it ("Cancelled in time: release").
 * Every PayPal write passes the gate; the amount always comes from the records, and only PayPal's read-back changes
 * what is recorded. PayPal keeps an authorization capturable for up to 29 days; the expiry it returns is shown.
 */
import { config } from "../config.js";
import type { Queryable } from "../db.js";
import { textCustomer } from "../channels/index.js";
import { appendAudit } from "../guard/audit.js";
import { gate } from "../guard/dryrun.js";
import { newId, requestKey } from "../lib/ids.js";
import { GtError } from "../lib/util.js";
import { paypal, toValue, UnknownOutcomeError, type PPAuthorization, type PPOrder } from "../paypal/index.js";
import { balanceOf, customerById, logEvent, obligationById, type Customer, type Obligation } from "../store.js";
import type { Run } from "../trace.js";
import type { Ctx } from "./money.js";
import { noteRef, wsCustomId } from "./wsrefs.js";
import { customerText, normLang, paypalLocale, usd as langUsd } from "../lib/lang.js";

export interface Hold {
  id: string;
  business_id: string;
  obligation_id: string;
  call_id: string | null;
  amount_cents: number;
  paypal_order_id: string | null;
  authorization_id: string | null;
  capture_id: string | null;
  approve_url: string | null;
  via: string;
  status: "creating" | "link_sent" | "authorized" | "captured" | "voided" | "expired" | "failed" | "unknown";
  expires_at: string | null;
  decided_by: string | null;
  created_at: string;
}

const customerUrl = (c: Customer) => `${config.appUrl}/c/${c.token}`;
const usd = (c: number) => `$${toValue(c)}`;
const RETRYABLE = new Set(["failed", "unknown", "creating"]);
const authOf = (o: PPOrder): PPAuthorization | undefined => o.purchase_units?.[0]?.payments?.authorizations?.[0];

function holdable(o: Obligation): number {
  if (o.kind !== "deposit") throw new GtError("Only a deposit can be held; this item is paid in full instead.", "not_deposit");
  const cents = balanceOf(o);
  if (cents <= 0) throw new GtError("Nothing is owed on this item.", "nothing_owed");
  return cents;
}

export async function holdsOf(q: Queryable, businessId: string, obligationId?: string): Promise<Hold[]> {
  const r = obligationId
    ? await q.query<Hold>("SELECT * FROM holds WHERE business_id = $1 AND obligation_id = $2 ORDER BY created_at DESC", [businessId, obligationId])
    : await q.query<Hold>("SELECT * FROM holds WHERE business_id = $1 ORDER BY created_at DESC LIMIT 100", [businessId]);
  return r.rows;
}
/** The hold that stands for this deposit now (a link waiting for the customer, or money held). */
export async function activeHold(q: Queryable, obligationId: string): Promise<Hold | null> {
  return (await q.query<Hold>("SELECT * FROM holds WHERE obligation_id = $1 AND status IN ('link_sent','authorized') ORDER BY created_at DESC LIMIT 1", [obligationId])).rows[0] ?? null;
}

/** On a call: text the customer a PayPal link that places the hold when they approve it. */
export async function sendHoldLink(ctx: Ctx, o: Obligation, customer: Customer): Promise<{ holdId: string; approveUrl: string | null; cents: number }> {
  const cents = holdable(o);
  const standing = await activeHold(ctx.q, o.id);
  if (standing) return { holdId: standing.id, approveUrl: standing.approve_url, cents: standing.amount_cents };
  await gate({ action: "hold", agentScope: ctx.agentScope, entity: "obligation", entityId: o.id, businessId: ctx.businessId, cents, trustedCents: [cents], personInitiated: ctx.personInitiated }, ctx.run, ctx.q);
  const requestId = requestKey("hold-link", o.id, cents, o.discount_cents);
  const existing = (await ctx.q.query<Hold>("SELECT * FROM holds WHERE request_id = $1", [requestId])).rows[0];
  if (existing && !RETRYABLE.has(existing.status)) return { holdId: existing.id, approveUrl: existing.approve_url, cents };
  if (existing) await ctx.q.query("DELETE FROM holds WHERE id = $1", [existing.id]);
  const id = newId("hld");
  await ctx.q.query("INSERT INTO holds (id, business_id, obligation_id, call_id, amount_cents, status, request_id, run_id, via) VALUES ($1,$2,$3,$4,$5,'creating',$6,$7,'link')", [id, ctx.businessId, o.id, ctx.callId, cents, requestId, ctx.run.id]);
  const pp = paypal();
  try {
    const order = await ctx.run.timed({ actor: "paypal", tool: "orders.create", args: { cents, intent: "AUTHORIZE", customId: o.id }, pp_request_id: requestId }, () => pp.createOrder({ amountCents: cents, currency: config.currency, customId: wsCustomId(o.id), description: `Hold: ${o.title}`.slice(0, 120), brand: ctx.businessName, locale: paypalLocale(customer.lang), intent: "AUTHORIZE", returnUrl: `${customerUrl(customer)}?held=1`, cancelUrl: customerUrl(customer) }, requestId), (r) => ({ id: r.id, status: r.status }));
    await noteRef("paypal.order", order.id);
    await ctx.q.query("UPDATE holds SET paypal_order_id = $2, approve_url = $3, status = 'link_sent' WHERE id = $1", [id, order.id, order.approveUrl]);
    const url = order.approveUrl ?? customerUrl(customer);
    const lang = normLang(customer.lang);
    await textCustomer(customer, lang && lang !== "en" ? customerText("hold_link", lang, { business: ctx.businessName, amount: langUsd(cents, lang), item: o.title, url }) : `${ctx.businessName}: approve a hold of ${usd(cents)} for ${o.title}. It is charged only if you attend, and released if you cancel in time: ${url}`, "obligation", o.id, ctx.q);
    await logEvent(ctx.q, { businessId: ctx.businessId, customerId: customer.id, callId: ctx.callId, type: "hold.link_sent", summary: `Hold link for ${usd(cents)} sent to ${customer.name} (charged only if they attend)`, actor: ctx.agentScope, data: { orderId: order.id } });
    await appendAudit("money.hold_link", "obligation", o.id, { cents, orderId: order.id, by: ctx.agentScope }, ctx.q);
    return { holdId: id, approveUrl: order.approveUrl, cents };
  } catch (e) {
    await ctx.q.query("UPDATE holds SET status = $2 WHERE id = $1", [id, e instanceof UnknownOutcomeError ? "unknown" : "failed"]);
    throw e;
  }
}

/** Demo only: the customer approves the hold from the demo's saved sandbox wallet (no PayPal login). */
export async function holdFromDemoWallet(ctx: Ctx, o: Obligation, customer: Customer): Promise<{ holdId: string; orderId: string; authorizationId: string; cents: number; expiresAt: string | null }> {
  if (!config.demoMode) throw new GtError("The saved demo wallet only pays inside the demo.", "not_demo", 403);
  const vaultId = config.paypal.demoVaultToken;
  if (!vaultId) throw new GtError("The demo's saved PayPal wallet is not set up. Use the hold link on PayPal's own page instead.", "no_wallet", 409);
  const cents = holdable(o);
  const standing = await activeHold(ctx.q, o.id);
  if (standing?.status === "authorized") return { holdId: standing.id, orderId: standing.paypal_order_id ?? "", authorizationId: standing.authorization_id ?? "", cents: standing.amount_cents, expiresAt: standing.expires_at };
  await gate({ action: "hold", agentScope: ctx.agentScope, entity: "obligation", entityId: o.id, businessId: ctx.businessId, cents, trustedCents: [cents], personInitiated: true }, ctx.run, ctx.q);
  const requestId = requestKey("hold-wallet", o.id, cents, o.discount_cents);
  const existing = (await ctx.q.query<Hold>("SELECT * FROM holds WHERE request_id = $1", [requestId])).rows[0];
  if (existing?.status === "authorized") return { holdId: existing.id, orderId: existing.paypal_order_id ?? "", authorizationId: existing.authorization_id ?? "", cents, expiresAt: existing.expires_at };
  if (existing) await ctx.q.query("DELETE FROM holds WHERE id = $1", [existing.id]);
  // A hold link the customer did not use is replaced by the wallet hold.
  if (standing?.status === "link_sent") await ctx.q.query("UPDATE holds SET status = 'expired' WHERE id = $1", [standing.id]);
  const id = newId("hld");
  await ctx.q.query("INSERT INTO holds (id, business_id, obligation_id, call_id, amount_cents, status, request_id, run_id, via) VALUES ($1,$2,$3,$4,$5,'creating',$6,$7,'demo_wallet')", [id, ctx.businessId, o.id, ctx.callId, cents, requestId, ctx.run.id]);
  const pp = paypal();
  try {
    const created = await ctx.run.timed({ actor: "paypal", tool: "orders.create", args: { cents, intent: "AUTHORIZE", customId: o.id, payment_source: "paypal.vault_id (saved demo wallet)" }, pp_request_id: requestId }, () => pp.createVaultOrder({ amountCents: cents, currency: config.currency, customId: wsCustomId(o.id), description: `Hold: ${o.title}`.slice(0, 120), brand: ctx.businessName, vaultId, intent: "AUTHORIZE" }, requestId), (r) => ({ id: r.id, status: r.status }));
    await noteRef("paypal.order", created.id);
    const order = await ctx.run.timed({ actor: "paypal", tool: "orders.get", args: { orderId: created.id } }, () => pp.getOrder(created.id), (r) => ({ status: r.status, authorization: authOf(r)?.status ?? null }));
    const auth = authOf(order);
    if (order.status !== "COMPLETED" || !auth || auth.status !== "CREATED") {
      await ctx.q.query("UPDATE holds SET paypal_order_id = $2, status = 'failed' WHERE id = $1", [id, created.id]);
      throw new GtError(`PayPal did not place the hold (order ${created.id} is ${order.status}${auth ? `, authorization ${auth.status}` : ""}). Nothing is held.`, "not_authorized", 502);
    }
    await recordAuthorized(ctx.q, id, created.id, auth);
    await logEvent(ctx.q, { businessId: ctx.businessId, customerId: customer.id, callId: ctx.callId, type: "hold.authorized", summary: `${usd(cents)} held on ${customer.name}'s saved sandbox wallet for ${o.title} (PayPal authorization ${auth.id}); charged only if they attend`, actor: "paypal", data: { orderId: created.id, authorizationId: auth.id } });
    await appendAudit("money.hold_authorized", "obligation", o.id, { orderId: created.id, authorizationId: auth.id, cents, via: "demo_wallet" }, ctx.q);
    return { holdId: id, orderId: created.id, authorizationId: auth.id, cents, expiresAt: auth.expiration_time ?? null };
  } catch (e) {
    if (!(e instanceof GtError)) await ctx.q.query("UPDATE holds SET status = $2 WHERE id = $1", [id, e instanceof UnknownOutcomeError ? "unknown" : "failed"]);
    throw e;
  }
}

async function recordAuthorized(q: Queryable, holdId: string, orderId: string, auth: PPAuthorization) {
  await noteRef("paypal.authorization", auth.id);
  await q.query("UPDATE holds SET paypal_order_id = $2, authorization_id = $3, expires_at = $4, status = 'authorized' WHERE id = $1", [holdId, orderId, auth.id, auth.expiration_time ?? null]);
}

/** The worker: a customer approved the hold link on PayPal's page, so the order is authorized (the customer's tap is the approval). */
export async function authorizeApprovedHold(q: Queryable, h: Hold, run: Run): Promise<boolean> {
  const o = await obligationById(q, h.obligation_id);
  await gate({ action: "hold", agentScope: "worker", entity: "obligation", entityId: o.id, businessId: h.business_id, cents: h.amount_cents, trustedCents: [h.amount_cents], personInitiated: true }, run, q);
  const requestId = requestKey("hold-authorize", h.paypal_order_id);
  const pp = paypal();
  const order = await run.timed({ actor: "paypal", tool: "orders.authorize", args: { orderId: h.paypal_order_id }, pp_request_id: requestId }, () => pp.authorizeOrder(h.paypal_order_id!, requestId), (x) => ({ status: x.status, authorization: authOf(x)?.status ?? null }));
  const auth = authOf(order);
  if (!auth || auth.status !== "CREATED") return false;
  await recordAuthorized(q, h.id, h.paypal_order_id!, auth);
  const cu = await customerById(q, o.customer_id);
  await logEvent(q, { businessId: h.business_id, customerId: cu.id, callId: h.call_id, type: "hold.authorized", summary: `${usd(h.amount_cents)} held for ${o.title} (PayPal authorization ${auth.id}); charged only if ${cu.name} attends`, actor: "paypal", data: { orderId: h.paypal_order_id, authorizationId: auth.id } });
  await appendAudit("money.hold_authorized", "obligation", o.id, { orderId: h.paypal_order_id, authorizationId: auth.id, cents: h.amount_cents, via: "link" }, q);
  return true;
}

/** Read-back for holds: an approved link is authorized; an authorization PayPal now reports differently is recorded as PayPal says. */
export async function readBackHolds(q: Queryable, businessId: string, run: Run): Promise<number> {
  const pp = paypal();
  let changed = 0;
  for (const h of (await q.query<Hold>("SELECT * FROM holds WHERE business_id = $1 AND status IN ('link_sent','authorized')", [businessId])).rows) {
    try {
      if (h.status === "link_sent" && h.paypal_order_id) {
        const order = await pp.getOrder(h.paypal_order_id);
        if (order.status === "APPROVED" && (await authorizeApprovedHold(q, h, run))) changed++;
        else if (order.status === "COMPLETED" && authOf(order)?.status === "CREATED") {
          await recordAuthorized(q, h.id, h.paypal_order_id, authOf(order)!);
          changed++;
        }
      } else if (h.status === "authorized" && h.authorization_id) {
        const a = await pp.getAuthorization(h.authorization_id);
        const to = a.status === "VOIDED" ? "voided" : a.status === "EXPIRED" ? "expired" : null;
        if (to) {
          await q.query("UPDATE holds SET status = $2 WHERE id = $1", [h.id, to]);
          changed++;
        }
      }
    } catch (e) {
      await run.step({ actor: "paypal", tool: "read_back.error", args: { hold: h.id }, result: { error: (e as Error).message.slice(0, 200) } });
    }
  }
  return changed;
}

/**
 * The owner settles a hold after the appointment: "capture" when the customer attended (the deposit is charged),
 * "void" when they cancelled in time (the hold is released and the deposit is waived). PayPal's live authorization
 * is read first; a hold PayPal already voided or that expired is recorded as such and nothing is sent.
 */
export async function settleHold(ctx: Ctx, holdId: string, how: "capture" | "void"): Promise<{ message: string; captureId?: string }> {
  const h = (await ctx.q.query<Hold>("SELECT * FROM holds WHERE id = $1 AND business_id = $2", [holdId, ctx.businessId])).rows[0];
  if (!h) throw new GtError("No such hold.", "not_found", 404);
  if (h.status !== "authorized" || !h.authorization_id) throw new GtError(`This hold is ${h.status.replace(/_/g, " ")}, so there is nothing to ${how === "capture" ? "charge" : "release"}.`, "bad_state");
  const o = await obligationById(ctx.q, h.obligation_id);
  const cu = await customerById(ctx.q, o.customer_id);
  const pp = paypal();
  const live = await ctx.run.timed({ actor: "paypal", tool: "authorizations.get", args: { authorizationId: h.authorization_id } }, () => pp.getAuthorization(h.authorization_id!), (a) => ({ status: a.status }));
  if (live.status !== "CREATED") {
    const to = live.status === "CAPTURED" ? "captured" : live.status === "VOIDED" ? "voided" : "expired";
    await ctx.q.query("UPDATE holds SET status = $2 WHERE id = $1", [h.id, to]);
    throw new GtError(`PayPal reports this hold as ${live.status}, so nothing was sent. The record now says ${to}.`, "paypal_state", 409);
  }
  // A capture is a charge; a void moves no money but is still a PayPal write, so it passes the gate too (a kill switch stops it).
  await gate({ action: how === "capture" ? "charge" : "hold", agentScope: ctx.agentScope, entity: "obligation", entityId: o.id, businessId: ctx.businessId, cents: h.amount_cents, trustedCents: [h.amount_cents], personInitiated: ctx.personInitiated }, ctx.run, ctx.q);
  if (how === "capture") {
    const requestId = requestKey("hold-capture", h.authorization_id, h.amount_cents);
    const cap = await ctx.run.timed({ actor: "paypal", tool: "authorizations.capture", args: { authorizationId: h.authorization_id, cents: h.amount_cents }, pp_request_id: requestId }, () => pp.captureAuthorization(h.authorization_id!, h.amount_cents, config.currency, requestId), (c) => ({ id: c.id, status: c.status }));
    await noteRef("paypal.capture", cap.id);
    const paid = Math.round(Number(cap.amount?.value ?? toValue(h.amount_cents)) * 100);
    await ctx.q.query("UPDATE holds SET status = 'captured', capture_id = $2, decided_at = now(), decided_by = $3 WHERE id = $1", [h.id, cap.id, ctx.agentScope]);
    await ctx.q.query("UPDATE obligations SET status = 'paid', capture_id = $2, paypal_order_id = $3, settled_cents = settled_cents + $4 WHERE id = $1", [o.id, cap.id, h.paypal_order_id, paid]);
    await logEvent(ctx.q, { businessId: ctx.businessId, customerId: cu.id, callId: h.call_id, type: "payment.captured", summary: `${cu.name} attended: the ${usd(paid)} hold for ${o.title} was charged (PayPal capture ${cap.id}, ${cap.status})`, actor: ctx.agentScope, data: { authorizationId: h.authorization_id, captureId: cap.id } });
    await appendAudit("money.hold_captured", "obligation", o.id, { authorizationId: h.authorization_id, captureId: cap.id, cents: paid }, ctx.q);
    return { message: `Charged ${usd(paid)} from the hold (PayPal capture ${cap.id}).`, captureId: cap.id };
  }
  const requestId = requestKey("hold-void", h.authorization_id);
  await ctx.run.timed({ actor: "paypal", tool: "authorizations.void", args: { authorizationId: h.authorization_id }, pp_request_id: requestId }, () => pp.voidAuthorization(h.authorization_id!, requestId), () => ({ voided: true }));
  // Read back: PayPal's own status decides the record.
  const after = await pp.getAuthorization(h.authorization_id);
  if (after.status !== "VOIDED") throw new GtError(`PayPal still reports the hold as ${after.status}; nothing is recorded as released.`, "paypal_state", 502);
  await ctx.q.query("UPDATE holds SET status = 'voided', decided_at = now(), decided_by = $2 WHERE id = $1", [h.id, ctx.agentScope]);
  await ctx.q.query("UPDATE obligations SET status = 'void' WHERE id = $1 AND status <> 'paid'", [o.id]);
  await logEvent(ctx.q, { businessId: ctx.businessId, customerId: cu.id, callId: h.call_id, type: "hold.released", summary: `${cu.name} cancelled in time: the ${usd(h.amount_cents)} hold for ${o.title} was released (PayPal authorization ${h.authorization_id} voided)`, actor: ctx.agentScope, data: { authorizationId: h.authorization_id } });
  await appendAudit("money.hold_voided", "obligation", o.id, { authorizationId: h.authorization_id, cents: h.amount_cents }, ctx.q);
  return { message: `Released the ${usd(h.amount_cents)} hold (PayPal authorization ${h.authorization_id} voided). Nothing was charged.` };
}
