/** Typed reads of the core records. Writes live in the services. */
import type { Queryable } from "./db.js";
import { GtError } from "./lib/util.js";
import type { Consent } from "./core/consent.js";

export interface Biz {
  id: string;
  key: string;
  name: string;
  tz: string;
  currency: string;
  phone: string;
  sim_now: string | null;
  settings: Record<string, unknown>;
}
export interface Person {
  id: string;
  business_id: string;
  name: string;
  role: "owner" | "staff";
}
export interface Customer {
  id: string;
  business_id: string;
  name: string;
  phone: string;
  email: string;
  tz: string;
  token: string;
  consent: Consent | null;
  dnc: boolean;
  notes: string;
}
export type ObligationKind = "deposit" | "invoice" | "class_cancel";
export type ObligationStatus = "open" | "link_sent" | "invoiced" | "planned" | "paid" | "credited" | "refunded" | "void";
export interface Obligation {
  id: string;
  business_id: string;
  customer_id: string;
  kind: ObligationKind;
  title: string;
  amount_cents: number;
  due_at: string | null;
  appointment_at: string | null;
  status: ObligationStatus;
  paypal_order_id: string | null;
  capture_id: string | null;
  paypal_invoice_id: string | null;
  subscription_id: string | null;
  discount_cents: number;
  settled_cents: number;
}
export type CallPurpose = "confirm_deposit" | "chase_invoice" | "cancel_class";
export type CallStatus = "planned" | "blocked" | "ringing" | "in_progress" | "ended" | "skipped";
export interface Turn {
  who: "agent" | "customer" | "system";
  text: string;
  at: string;
  quarantined?: string[];
  tool?: string | null;
}
export interface CallState {
  /** Four-digit "verify it's us" code spoken on the call and shown on the customer page (safety layer). */
  verify_code?: string;
  offered?: string[];
  discount_pct?: number;
  plan_id?: string | null;
  link_sent?: boolean;
  invoice_sent?: boolean;
  callback_at?: string | null;
  closed?: boolean;
  outcome?: string | null;
  turns?: number;
  brain?: "model" | "rules";
}
export interface Call {
  id: string;
  business_id: string;
  customer_id: string;
  obligation_id: string | null;
  purpose: CallPurpose;
  status: CallStatus;
  mode: "simulator" | "phone" | "realtime" | "eval";
  reason: string;
  outcome: string | null;
  persona: string | null;
  scheduled_at: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  transcript: Turn[];
  state: CallState;
  run_id: string | null;
  attempts: number;
  collected_cents: number;
  discount_cents: number;
  breaches: number;
  consent_ok: boolean | null;
  hours_ok: boolean | null;
  provider_call_id: string | null;
  created_at: Date;
}

const j = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);

export async function bizById(q: Queryable, id: string): Promise<Biz> {
  const r = (await q.query<Biz>("SELECT * FROM businesses WHERE id = $1", [id])).rows[0];
  if (!r) throw new GtError("No such business", "not_found", 404);
  return { ...r, settings: j(r.settings) ?? {} };
}
export async function bizByKey(q: Queryable, key: string): Promise<Biz | null> {
  const r = (await q.query<Biz>("SELECT * FROM businesses WHERE key = $1", [key])).rows[0];
  return r ? { ...r, settings: j(r.settings) ?? {} } : null;
}
export async function firstBiz(q: Queryable): Promise<Biz | null> {
  const r = (await q.query<Biz>("SELECT * FROM businesses ORDER BY created_at LIMIT 1")).rows[0];
  return r ? { ...r, settings: j(r.settings) ?? {} } : null;
}
/** The business clock: a demo may pin "now" so calling-hours checks are reproducible. */
export async function nowOf(q: Queryable, businessId: string): Promise<Date> {
  const r = (await q.query<{ sim_now: string | null }>("SELECT sim_now FROM businesses WHERE id = $1", [businessId])).rows[0];
  return r?.sim_now ? new Date(r.sim_now) : new Date();
}

export async function personById(q: Queryable, id: string): Promise<(Person & { business_name: string }) | null> {
  const r = (await q.query<Person & { business_name: string }>("SELECT p.id, p.business_id, p.name, p.role, b.name AS business_name FROM people p JOIN businesses b ON b.id = p.business_id WHERE p.id = $1", [id])).rows[0];
  return r ?? null;
}

const cust = (r: any): Customer => ({ ...r, consent: j(r.consent) ?? null });
export async function customerById(q: Queryable, id: string, businessId?: string): Promise<Customer> {
  const r = (await q.query<any>("SELECT * FROM customers WHERE id = $1", [id])).rows[0];
  if (!r || (businessId && r.business_id !== businessId)) throw new GtError("No such customer", "not_found", 404);
  return cust(r);
}
export async function customerByToken(q: Queryable, token: string): Promise<Customer> {
  const r = (await q.query<any>("SELECT * FROM customers WHERE token = $1", [token])).rows[0];
  if (!r) throw new GtError("No such link", "not_found", 404);
  return cust(r);
}
export async function customersOf(q: Queryable, businessId: string): Promise<Customer[]> {
  return (await q.query<any>("SELECT * FROM customers WHERE business_id = $1 ORDER BY name", [businessId])).rows.map(cust);
}

const obl = (r: any): Obligation => ({ ...r, amount_cents: Number(r.amount_cents), discount_cents: Number(r.discount_cents), settled_cents: Number(r.settled_cents) });
export async function obligationById(q: Queryable, id: string, businessId?: string): Promise<Obligation> {
  const r = (await q.query<any>("SELECT * FROM obligations WHERE id = $1", [id])).rows[0];
  if (!r || (businessId && r.business_id !== businessId)) throw new GtError("No such obligation", "not_found", 404);
  return obl(r);
}
export async function obligationsOf(q: Queryable, businessId: string, customerId?: string): Promise<Obligation[]> {
  const rows = customerId ? (await q.query<any>("SELECT * FROM obligations WHERE business_id = $1 AND customer_id = $2 ORDER BY created_at", [businessId, customerId])).rows : (await q.query<any>("SELECT * FROM obligations WHERE business_id = $1 ORDER BY created_at", [businessId])).rows;
  return rows.map(obl);
}
/** What is still owed on an obligation, after discount and anything settled. */
export const balanceOf = (o: Obligation) => Math.max(0, o.amount_cents - o.discount_cents - o.settled_cents);
/** A cancelled class the customer already paid for: what the business owes back until it is refunded or credited. */
export const owedToCustomer = (o: Obligation) => (o.kind === "class_cancel" && !["refunded", "credited", "void"].includes(o.status) ? o.settled_cents : 0);

const call = (r: any): Call => ({ ...r, transcript: j(r.transcript) ?? [], state: j(r.state) ?? {}, attempts: Number(r.attempts), collected_cents: Number(r.collected_cents), discount_cents: Number(r.discount_cents), breaches: Number(r.breaches) });
export async function callById(q: Queryable, id: string, businessId?: string): Promise<Call> {
  const r = (await q.query<any>("SELECT * FROM calls WHERE id = $1", [id])).rows[0];
  if (!r || (businessId && r.business_id !== businessId)) throw new GtError("No such call", "not_found", 404);
  return call(r);
}
export async function callsOf(q: Queryable, businessId: string, opts: { status?: CallStatus[]; customerId?: string; limit?: number } = {}): Promise<Call[]> {
  const params: unknown[] = [businessId];
  let sql = "SELECT * FROM calls WHERE business_id = $1";
  if (opts.status?.length) {
    params.push(opts.status);
    sql += ` AND status = ANY($${params.length})`;
  }
  if (opts.customerId) {
    params.push(opts.customerId);
    sql += ` AND customer_id = $${params.length}`;
  }
  params.push(opts.limit ?? 200);
  sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
  return (await q.query<any>(sql, params)).rows.map(call);
}
export async function callAttempts(q: Queryable, customerId: string, now: Date): Promise<{ attempts_today: number; last_attempt_at: Date | null }> {
  const dayStart = new Date(now.getTime() - 24 * 3600_000);
  const r = (await q.query<{ n: string; last: Date | null }>("SELECT count(*) FILTER (WHERE started_at > $2) AS n, max(started_at) AS last FROM calls WHERE customer_id = $1 AND started_at IS NOT NULL", [customerId, dayStart])).rows[0];
  return { attempts_today: Number(r?.n ?? 0), last_attempt_at: r?.last ? new Date(r.last) : null };
}

export async function logEvent(q: Queryable, e: { businessId: string; customerId?: string | null; callId?: string | null; type: string; summary: string; actor?: string; data?: unknown }) {
  await q.query("INSERT INTO events (business_id, customer_id, call_id, type, summary, actor, data) VALUES ($1,$2,$3,$4,$5,$6,$7)", [e.businessId, e.customerId ?? null, e.callId ?? null, e.type, e.summary, e.actor ?? "system", e.data === undefined ? null : JSON.stringify(e.data)]);
}
export async function eventsOf(q: Queryable, businessId: string, filter: { customerId?: string; callId?: string } = {}, limit = 100) {
  const params: unknown[] = [businessId];
  let sql = "SELECT * FROM events WHERE business_id = $1";
  if (filter.customerId) {
    params.push(filter.customerId);
    sql += ` AND customer_id = $${params.length}`;
  }
  if (filter.callId) {
    params.push(filter.callId);
    sql += ` AND call_id = $${params.length}`;
  }
  params.push(limit);
  return (await q.query<any>(sql + ` ORDER BY at DESC LIMIT $${params.length}`, params)).rows;
}
