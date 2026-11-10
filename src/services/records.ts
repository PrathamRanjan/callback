/**
 * The owner's own records: add a customer (with the consent they gave, in their words), add something they owe
 * (a deposit before an appointment, an invoice), and cancel a booking they already paid for, which creates the
 * cancelled-class item the agent then settles by PayPal refund or credit. Nothing here moves money; the planner
 * picks the new items up on its next pass, and every call still passes consent, hours and the gate.
 */
import { scopedSecret, type Queryable } from "../db.js";
import { appendAudit } from "../guard/audit.js";
import { newId } from "../lib/ids.js";
import { GtError } from "../lib/util.js";
import { customerById, logEvent, obligationById, type Customer, type Obligation } from "../store.js";

const MAX_CENTS = 1_000_000;

export function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Phone numbers in international form: a plus, then 8 to 15 digits (spaces and dashes allowed). */
export function normalisePhone(raw: string): string {
  const t = raw.trim();
  const digits = t.replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(digits)) throw new GtError("Phone must be in international form, for example +61 491 570 110.", "bad_phone");
  return t.replace(/\s+/g, " ");
}

/** Dollars typed by a person ("60", "60.5", "1,250.00") to whole cents. Rejects anything else. */
export function centsFromDollars(raw: unknown): number {
  const s = String(raw ?? "").trim().replace(/,/g, "").replace(/^\$/, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) throw new GtError("Enter the amount in dollars, for example 60 or 125.50.", "bad_amount");
  const [d, c = ""] = s.split(".");
  const cents = Number(d) * 100 + Number((c + "00").slice(0, 2));
  if (cents <= 0 || cents > MAX_CENTS) throw new GtError("The amount must be between $0.01 and $10,000.", "bad_amount");
  return cents;
}

function isoOrThrow(raw: unknown, what: string): string {
  const d = new Date(String(raw ?? ""));
  if (Number.isNaN(d.getTime())) throw new GtError(`Pick the ${what}.`, "bad_date");
  return d.toISOString();
}

export interface NewCustomer {
  name: string;
  phone: string;
  email?: string;
  tz: string;
  notes?: string;
  /** The words the customer agreed to and where; without them the customer is never called. */
  consent?: { text: string; source: string } | null;
}

export async function createCustomer(q: Queryable, businessId: string, input: NewCustomer, by: string): Promise<Customer> {
  const name = String(input.name ?? "").trim().slice(0, 120);
  if (name.length < 2) throw new GtError("Add the customer's name.", "bad_name");
  const phone = normalisePhone(String(input.phone ?? ""));
  const email = String(input.email ?? "").trim().slice(0, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new GtError("That email address does not look right.", "bad_email");
  const tz = String(input.tz ?? "").trim();
  if (!validTz(tz)) throw new GtError("Pick the customer's time zone.", "bad_tz");
  const dupe = (await q.query("SELECT 1 FROM customers WHERE business_id = $1 AND regexp_replace(phone, '[^0-9+]', '', 'g') = $2", [businessId, phone.replace(/[^0-9+]/g, "")])).rows.length;
  if (dupe) throw new GtError("A customer with that phone number already exists.", "duplicate");
  const consentText = input.consent?.text?.trim();
  const consent = consentText ? { granted_at: new Date().toISOString(), source: String(input.consent?.source ?? "").trim().slice(0, 120) || "recorded by the owner", text: consentText.slice(0, 500), revoked_at: null } : null;
  const id = newId("cus");
  await q.query("INSERT INTO customers (id, business_id, name, phone, email, tz, token, consent, dnc, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,$9)", [id, businessId, name, phone, email, tz, scopedSecret("cbt"), consent ? JSON.stringify(consent) : null, String(input.notes ?? "").trim().slice(0, 500)]);
  await appendAudit("customer.created", "customer", id, { by, consent: Boolean(consent) }, q);
  await logEvent(q, { businessId, customerId: id, type: "customer.created", summary: `${by} added ${name}${consent ? " with consent to call" : " (no consent: never called)"}`, actor: by });
  return customerById(q, id, businessId);
}

export interface NewCharge {
  customerId: string;
  kind: "deposit" | "invoice";
  title: string;
  amount: string | number;
  /** Deposit: when it is due (before the appointment). Invoice: its due date. */
  dueAt: string;
  /** Deposit only: the appointment it secures. */
  appointmentAt?: string | null;
  note?: string;
}

export async function createCharge(q: Queryable, businessId: string, input: NewCharge, by: string): Promise<Obligation> {
  const c = await customerById(q, String(input.customerId ?? ""), businessId);
  if (input.kind !== "deposit" && input.kind !== "invoice") throw new GtError("Pick a deposit or an invoice.", "bad_kind");
  const title = String(input.title ?? "").trim().slice(0, 120);
  if (title.length < 3) throw new GtError("Say what it is for, for example 'Deposit for initial assessment'.", "bad_title");
  const cents = centsFromDollars(input.amount);
  const dueAt = isoOrThrow(input.dueAt, input.kind === "deposit" ? "deposit due time" : "invoice due date");
  const appt = input.kind === "deposit" ? isoOrThrow(input.appointmentAt, "appointment time") : null;
  if (appt && new Date(appt).getTime() < new Date(dueAt).getTime()) throw new GtError("The deposit must be due before the appointment.", "bad_date");
  const id = newId("obl");
  await q.query("INSERT INTO obligations (id, business_id, customer_id, kind, title, amount_cents, due_at, appointment_at, status, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9)", [id, businessId, c.id, input.kind, title, cents, dueAt, appt, String(input.note ?? "").trim().slice(0, 300)]);
  await appendAudit("obligation.created", "obligation", id, { by, kind: input.kind, cents }, q);
  await logEvent(q, { businessId, customerId: c.id, type: "obligation.created", summary: `${by} added ${title} ($${(cents / 100).toFixed(2)}) for ${c.name}`, actor: by });
  return obligationById(q, id, businessId);
}

/**
 * The owner cancels an appointment or class the customer has paid for. A new cancelled-class item records what is
 * owed back, with the owner's reason (the only reason the agent may give) and, if it was paid by PayPal, the capture
 * the refund must go back to. The original paid item stays as it was.
 */
export async function cancelBooking(q: Queryable, businessId: string, obligationId: string, reasonRaw: string, by: string): Promise<Obligation> {
  const o = await obligationById(q, obligationId, businessId);
  if (o.kind !== "deposit") throw new GtError("Only a paid booking can be cancelled here.", "wrong_kind");
  if (o.status !== "paid" || o.settled_cents <= 0) throw new GtError("This booking is not paid yet, so there is nothing to give back. Remove the appointment instead.", "not_paid");
  const reason = String(reasonRaw ?? "").trim().slice(0, 160);
  if (reason.length < 3) throw new GtError("Say why it is cancelled; the agent will tell the customer exactly this.", "bad_reason");
  const already = (await q.query("SELECT 1 FROM obligations WHERE source_id = $1", [o.id])).rows.length;
  if (already) throw new GtError("This booking is already cancelled.", "duplicate");
  const id = newId("obl");
  const title = `${o.title.replace(/^Deposit for /i, "")} cancelled`.replace(/^./, (x) => x.toUpperCase()).slice(0, 120);
  await q.query("INSERT INTO obligations (id, business_id, customer_id, kind, title, amount_cents, due_at, appointment_at, status, capture_id, settled_cents, note, source_id) VALUES ($1,$2,$3,'class_cancel',$4,$5,NULL,$6,'open',$7,$5,$8,$9)", [id, businessId, o.customer_id, title, o.settled_cents, o.appointment_at, o.capture_id, reason, o.id]);
  await appendAudit("booking.cancelled", "obligation", o.id, { by, reason, cancelItem: id, captureId: o.capture_id, cents: o.settled_cents }, q);
  await logEvent(q, { businessId, customerId: o.customer_id, type: "booking.cancelled", summary: `${by} cancelled ${o.title}: ${reason}. $${(o.settled_cents / 100).toFixed(2)} is owed back${o.capture_id ? " to the PayPal payment" : ""}.`, actor: by });
  return obligationById(q, id, businessId);
}
