/**
 * Demo data: one small business (a physiotherapy and Pilates studio), its owner and front-desk person, eight customers
 * with mixed consent and time zones, and the money that needs a call: tomorrow's deposits, overdue invoices, a cancelled
 * class. Phone numbers are from the ranges Australia and the US reserve for fiction, so nothing here can ring a real person. Plus the 90-day by-hand call history for the backtest and a default policy.
 */
import { scopedSecret, type Db } from "../db.js";
import { compileLocal, savePolicy } from "../guard/policy.js";
import { seedHistory } from "../guard/backtest.js";
import { newId } from "../lib/ids.js";
import { hashKey } from "../lib/util.js";
import { addDays, addHours } from "../core/time.js";

export interface Seeded {
  business: { id: string; name: string; tz: string };
  ownerKey: string;
  staffKey: string;
  customers: Record<string, { id: string; token: string }>;
  obligations: Record<string, string>;
}

export async function seedDemo(db: Db, opts: { now?: Date; pinClock?: boolean; ws?: string } = {}): Promise<Seeded> {
  const existing = (await db.query<{ id: string }>("SELECT id FROM businesses WHERE key = 'brightside'")).rows[0];
  if (existing) throw new Error("Already seeded");
  const now = opts.now ?? new Date();
  const bizId = newId("biz");
  const tz = "Australia/Sydney";
  await db.query("INSERT INTO businesses (id, key, name, tz, currency, phone, sim_now, settings) VALUES ($1,'brightside',$2,$3,'USD',$4,$5,$6)", [bizId, "Brightside Physio & Pilates", tz, "+61 2 5550 0100", opts.pinClock ? now.toISOString() : null, JSON.stringify({ owner_name: "Maya Chen", contacts: ["accounts@brightside-physio.example"] })]);
  const ownerKey = scopedSecret("cbo");
  const staffKey = scopedSecret("cbs");
  const ownerId = newId("per");
  await db.query("INSERT INTO people (id, business_id, name, role, key_hash) VALUES ($1,$2,'Maya Chen','owner',$3)", [ownerId, bizId, hashKey(ownerKey)]);
  await db.query("INSERT INTO people (id, business_id, name, role, key_hash) VALUES ($1,$2,'Jordan Lee','staff',$3)", [newId("per"), bizId, hashKey(staffKey)]);

  const consent = (daysAgo: number, source = "booking form") => JSON.stringify({ granted_at: addDays(now, -daysAgo).toISOString(), source, text: "You may call or text me about my bookings and account.", revoked_at: null });
  const customers: Record<string, { id: string; token: string }> = {};
  const rows: [string, string, string, string, string, string | null, boolean, string][] = [
    // key, name, phone, email, tz, consent json, dnc, notes
    ["priya", "Priya Natarajan", "+61 491 570 006", "priya@example.com", tz, consent(40), false, "Regular. Prefers texts for links."],
    ["marcus", "Marcus Okafor", "+61 491 570 156", "marcus@example.com", tz, consent(12), false, ""],
    ["harbour", "Harbour Dental (Dr Lim)", "+61 2 5550 4321", "accounts@harbourdental.example", tz, consent(200, "contract"), false, "Corporate account: monthly staff Pilates. Pays late, always pays."],
    ["lena", "Lena Kowalski", "+61 491 570 157", "lena@example.com", tz, consent(5), false, "New client."],
    ["tom", "Tom Reyes", "+61 491 570 158", "tom@example.com", tz, consent(90), false, "Asks for discounts every time."],
    ["dev", "Dev Sharma", "+1 415 555 0101", "dev@example.com", "Europe/London", consent(30), false, "Travelling: on UK time this month."],
    ["noor", "Noor Haddad", "+61 491 570 159", "noor@example.com", tz, null, false, "No consent on file: never call, invoice only."],
    ["sam", "Sam Whitfield", "+61 491 570 110", "sam@example.com", tz, consent(60), true, "Asked not to be called (DNC)."],
  ];
  for (const [key, name, phone, email, ctz, cons, dnc, notes] of rows) {
    const id = newId("cus");
    const token = scopedSecret("cbt");
    await db.query("INSERT INTO customers (id, business_id, name, phone, email, tz, token, consent, dnc, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [id, bizId, name, phone, email, ctz, token, cons, dnc, notes]);
    customers[key] = { id, token };
  }

  const obligations: Record<string, string> = {};
  const obl = async (key: string, cust: string, kind: "deposit" | "invoice" | "class_cancel", title: string, cents: number, dueAt: Date | null, apptAt: Date | null, status = "open", extra: Record<string, unknown> = {}) => {
    const id = newId("obl");
    await db.query("INSERT INTO obligations (id, business_id, customer_id, kind, title, amount_cents, due_at, appointment_at, status, capture_id, settled_cents, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [id, bizId, customers[cust].id, kind, title, cents, dueAt?.toISOString() ?? null, apptAt?.toISOString() ?? null, status, extra.capture_id ?? null, extra.settled_cents ?? 0, extra.note ?? ""]);
    obligations[key] = id;
  };
  await obl("priya_deposit", "priya", "deposit", "Deposit for initial physio assessment", 6000, addHours(now, 20), addHours(now, 26));
  await obl("marcus_deposit", "marcus", "deposit", "Deposit for 6-week reformer block", 15000, addHours(now, 22), addHours(now, 30));
  await obl("harbour_invoice", "harbour", "invoice", "Invoice #1042: October staff Pilates", 42000, addDays(now, -18), null);
  await obl("lena_invoice", "lena", "invoice", "Invoice #1051: 3 physio sessions", 18000, addDays(now, -9), null);
  await obl("tom_invoice", "tom", "invoice", "Invoice #1047: reformer casual x4", 22000, addDays(now, -31), null);
  await obl("dev_deposit", "dev", "deposit", "Deposit for telehealth review", 9000, addHours(now, 20), addHours(now, 30));
  await obl("noor_invoice", "noor", "invoice", "Invoice #1055: initial consult", 12500, addDays(now, -10), null);
  await obl("sam_invoice", "sam", "invoice", "Invoice #1039: mat class block", 16000, addDays(now, -40), null);
  // The class title is written from the class's own time, so the item and the appointment can never disagree.
  const classAt = addHours(now, 50);
  const classWhen = new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "long", hour: "numeric", minute: "2-digit", hour12: true }).format(classAt).replace(":00", "").replace(" am", "am").replace(" pm", "pm");
  await obl("tom_class", "tom", "class_cancel", `${classWhen} reformer class`, 3500, null, classAt, "open", { capture_id: null, settled_cents: 3500, note: "the instructor is unwell" });

  await seedHistory(bizId, db);
  const policyText = "Call customers between 9am and 6pm, weekdays only, once a day at most. Confirm deposits for tomorrow's appointments and chase invoices more than a week overdue. You may offer up to 10% off to settle an overdue invoice today, or a plan of up to 3 payments with at least $50 per payment. Send links or invoices up to $300 without asking me; refunds up to $100 for cancelled classes. Be warm and brief.";
  await savePolicy(bizId, policyText, compileLocal(policyText), true, "seed", db);
  await db.query("INSERT INTO guard_settings (id) VALUES ($1) ON CONFLICT DO NOTHING", [bizId]);
  await db.query("INSERT INTO kill_switches (scope, engaged) VALUES ('global', false) ON CONFLICT DO NOTHING");
  return { business: { id: bizId, name: "Brightside Physio & Pilates", tz }, ownerKey, staffKey, customers, obligations };
}
