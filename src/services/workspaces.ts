/**
 * Private demo workspaces (spec A1). One tap on "Try the live demo" creates a workspace: its own Postgres schema with
 * the app's tables, seeded through the same code a real studio uses, on its own studio clock. Nobody else's actions
 * appear in it; it is removed after CB_WORKSPACE_IDLE_HOURS without a visit. The app's own schema keeps the registry
 * and the showcase studio that feeds the landing page.
 *
 * Seeding has two parts. The rows a visitor needs to start (studio, people, customers, money owed, the policy, today's
 * plan, one move held for the owner) are written before the page opens. The real PayPal payments in the seed (a class
 * booking and two deposits paid on earlier calls) are made in the background from the demo's saved sandbox wallet and
 * read back; the workspace shows "n of 3 payments confirmed by PayPal" until they are done.
 */
import { createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { addDays, addHours, localParts } from "../core/time.js";
import { APP_TABLES, createWorkspaceSchema, currentWs, dropWorkspaceSchema, getDb, inWorkspace, scopedSecret, WS_ID, type Db } from "../db.js";
import { HeldForApproval } from "../guard/dryrun.js";
import { newId } from "../lib/ids.js";
import { GtError } from "../lib/util.js";
import { bizById, customerById, logEvent, obligationById } from "../store.js";
import { startRun } from "../trace.js";
import { payFromDemoWallet, sendPayLink } from "./money.js";
import { cacheDrop, quietSteps } from "./wsrefs.js";
export { markStep, noteRef, splitCustomId, wsCustomId, wsForRef, wsFromSecret } from "./wsrefs.js";
import { planCalls } from "./planner.js";
import { seedDemo, type Seeded } from "./seed.js";

export interface Workspace {
  id: string;
  kind: "visitor" | "showcase";
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  seed_state: "seeding" | "ready" | "failed";
  seed_note: string;
  checklist: Record<string, string>;
  join_token: string | null;
}

const ALPHA = "abcdefghijkmnopqrstuvwxyz23456789";
export function newWsId(): string {
  let s = "";
  for (const b of randomBytes(10)) s += ALPHA[b % ALPHA.length];
  return s;
}
export const ipHash = (ip: string) => createHash("sha256").update(`cb-ip:${config.sessionSecret}:${ip}`).digest("hex").slice(0, 20);

const cache = new Map<string, { w: Workspace | null; at: number }>();
cacheDrop.fn = (id) => cache.delete(id);
const j = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
const row = (r: any): Workspace => ({ ...r, checklist: j(r.checklist) ?? {} });

export async function getWorkspace(id: string, fresh = false): Promise<Workspace | null> {
  if (!WS_ID.test(id)) return null;
  const hit = cache.get(id);
  if (!fresh && hit && Date.now() - hit.at < 15_000) return hit.w;
  const db = await getDb();
  const r = (await inWorkspace(null, () => db.query<any>("SELECT * FROM workspaces WHERE id = $1", [id]))).rows[0];
  const w = r ? row(r) : null;
  cache.set(id, { w, at: Date.now() });
  return w;
}

const lastTouch = new Map<string, number>();
/** A visit pushes the expiry out. Written at most every five minutes per workspace. */
export async function touchWorkspace(id: string) {
  if (Date.now() - (lastTouch.get(id) ?? 0) < 5 * 60_000) return;
  lastTouch.set(id, Date.now());
  const db = await getDb();
  await inWorkspace(null, () => db.query(`UPDATE workspaces SET last_seen_at = now(), expires_at = now() + interval '1 hour' * $2 WHERE id = $1`, [id, config.workspaces.idleHours]));
}

/**
 * The studio clock a new workspace starts on: 11:00 in Sydney on today's Sydney date, or the next Monday when today is
 * a weekend there, so calling hours are open and the seed reads like a working morning. Dates are always current,
 * never a fixed day. The visitor moves it with "+1 day"; nothing else changes it.
 */
export function demoClock(real = new Date(), tz = "Australia/Sydney"): Date {
  const lp = localParts(real, tz);
  const shift = lp.weekday === 6 ? 2 : lp.weekday === 0 ? 1 : 0;
  // 11:00 local on that date: start from 11:00 UTC on the date and correct by the zone's offset at that moment.
  const [y, m, d] = lp.date.split("-").map(Number);
  let guess = new Date(Date.UTC(y, m - 1, d + shift, 11, 0, 0));
  for (let i = 0; i < 2; i++) {
    const p = localParts(guess, tz);
    const [gy, gm, gd] = p.date.split("-").map(Number);
    const deltaMin = (Date.UTC(gy, gm - 1, gd, p.hour, p.minute) - Date.UTC(y, m - 1, d + shift, 11, 0)) / 60_000;
    guess = new Date(guess.getTime() - deltaMin * 60_000);
  }
  return guess;
}

async function registry<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const db = await getDb();
  return inWorkspace(null, () => fn(db));
}

/** POST /demo/start: rate limited per address, capped in total; when full, the longest-idle workspace is recycled. */
export async function startWorkspace(opts: { ip: string; kind?: "visitor" | "showcase" }): Promise<Workspace> {
  const ip = ipHash(opts.ip || "unknown");
  const kind = opts.kind ?? "visitor";
  if (kind === "visitor") {
    const recent = await registry((db) => db.query<{ n: number }>("SELECT count(*)::int AS n FROM ws_starts WHERE ip_hash = $1 AND at > now() - interval '1 hour'", [ip]));
    if ((recent.rows[0]?.n ?? 0) >= config.workspaces.startsPerHour) throw new GtError(`This address has started ${config.workspaces.startsPerHour} demos in the last hour. Keep using the one you have, or try again later.`, "rate_limited", 429);
    await expireWorkspaces();
    const live = await registry((db) => db.query<{ id: string; last_seen_at: Date }>("SELECT id, last_seen_at FROM workspaces WHERE kind = 'visitor' ORDER BY last_seen_at"));
    if (live.rows.length >= config.workspaces.maxLive) {
      const oldest = live.rows[0];
      if (Date.now() - new Date(oldest.last_seen_at).getTime() < 30 * 60_000) throw new GtError("Every demo slot is in use right now. Try again in a few minutes.", "full", 503);
      await removeWorkspace(oldest.id, "recycled for a new visitor");
    }
  }
  const id = newWsId();
  const joinToken = randomBytes(18).toString("base64url");
  await registry(async (db) => {
    await db.query("INSERT INTO workspaces (id, kind, expires_at, ip_hash, join_token) VALUES ($1,$2, now() + interval '1 hour' * $3, $4, $5)", [id, kind, config.workspaces.idleHours, ip, joinToken]);
    if (kind === "visitor") await db.query("INSERT INTO ws_starts (ip_hash) VALUES ($1)", [ip]);
  });
  await buildWorkspace(id);
  return (await getWorkspace(id, true))!;
}

/** "Reset my demo": the same workspace id (so the visitor's cookie and phone link keep working), rebuilt from scratch. */
export async function resetWorkspace(id: string): Promise<Workspace> {
  const w = await getWorkspace(id, true);
  if (!w) throw new GtError("That demo has expired. Start a new one.", "expired", 410);
  await voidOpenHolds(id);
  await registry((db) => db.query("UPDATE workspaces SET seed_state = 'seeding', seed_note = '', checklist = '{}' WHERE id = $1", [id]));
  await registry((db) => db.query("DELETE FROM ws_refs WHERE ws_id = $1", [id]));
  await buildWorkspace(id);
  return (await getWorkspace(id, true))!;
}

async function buildWorkspace(id: string) {
  const db = await getDb();
  try {
    await createWorkspaceSchema(db, id);
    const seeded = await quietSteps.run(true, () => inWorkspace(id, () => seedWorkspace(db, id)));
    await registry((r) => r.query("UPDATE workspaces SET seed_state = 'ready', seed_note = $2 WHERE id = $1", [id, config.paypal.demoVaultToken ? "Paying 3 sample items from the saved sandbox wallet…" : "The saved demo wallet is not set up, so the seed's sample payments were not made."]));
    cache.delete(id);
    // The real payments run after the page opens; their progress shows on Today.
    void quietSteps.run(true, () => inWorkspace(id, () => seedPayments(db, id, seeded))).catch((e) => console.error(`[workspace ${id}] seed payments`, (e as Error).message));
  } catch (e) {
    await registry((r) => r.query("UPDATE workspaces SET seed_state = 'failed', seed_note = $2 WHERE id = $1", [id, String((e as Error).message).slice(0, 300)]));
    cache.delete(id);
    throw e;
  }
}

export interface WorkspaceSeed extends Seeded {
  samples: { aisha: string; ben: string; ivyCall: string };
}

/** The rows a visitor needs before the first page: the studio as seedDemo writes it, plus three earlier calls. */
async function seedWorkspace(db: Db, id: string | null): Promise<WorkspaceSeed> {
  const clock = demoClock();
  const seeded = await seedDemo(db, { now: clock, pinClock: true, ws: id ?? undefined });
  const bizId = seeded.business.id;
  const tz = seeded.business.tz;
  const consent = JSON.stringify({ granted_at: addDays(clock, -20).toISOString(), source: "booking form", text: "You may call or text me about my bookings and account.", revoked_at: null });
  const extra = async (name: string, phone: string, email: string) => {
    const cid = newId("cus");
    await db.query("INSERT INTO customers (id, business_id, name, phone, email, tz, token, consent, dnc, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,'')", [cid, bizId, name, phone, email, tz, scopedSecret("cbt"), consent]);
    return cid;
  };
  const oblig = async (cust: string, kind: "deposit" | "invoice", title: string, cents: number, due: Date | null, appt: Date | null) => {
    const oid = newId("obl");
    await db.query("INSERT INTO obligations (id, business_id, customer_id, kind, title, amount_cents, due_at, appointment_at, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open')", [oid, bizId, cust, kind, title, cents, due?.toISOString() ?? null, appt?.toISOString() ?? null]);
    return oid;
  };
  // Three calls from earlier this morning. They are samples: written for the demo, no one was phoned. The money that
  // follows them is real (two payments from the saved wallet, one move held for the owner) and labelled as such.
  const sampleCall = async (custId: string, oblId: string, purpose: string, minutesAgo: number, lines: [string, string][], outcome: string) => {
    const cid = newId("call");
    const startedAt = addHours(clock, -minutesAgo / 60);
    const transcript = [{ who: "system", text: "Sample call written for the demo: nobody was phoned. Any payment shown with it is real sandbox money, marked as paid from the demo's saved wallet.", at: startedAt.toISOString() }, ...lines.map(([who, text], i) => ({ who, text, at: new Date(startedAt.getTime() + (i + 1) * 20_000).toISOString() }))];
    await db.query("INSERT INTO calls (id, business_id, customer_id, obligation_id, purpose, status, mode, reason, outcome, started_at, ended_at, transcript, state, is_sample) VALUES ($1,$2,$3,$4,$5,'ended','simulator',$6,$7,$8,$9,$10,$11,true)", [cid, bizId, custId, oblId, purpose, "sample call from earlier today", outcome, startedAt, new Date(startedAt.getTime() + (lines.length + 1) * 20_000), JSON.stringify(transcript), JSON.stringify({ closed: true, outcome })]);
    return cid;
  };
  const aishaC = await extra("Aisha Rahman", "+61 491 570 160", "aisha@example.com");
  const aisha = await oblig(aishaC, "deposit", "Deposit for a 45-minute physio session", 4500, addHours(clock, 4), addHours(clock, 8));
  await sampleCall(aishaC, aisha, "confirm_deposit", 95, [["agent", "Hi Aisha, it's the assistant for Brightside Physio & Pilates. You're booked in this afternoon and the $45 deposit is still open. Shall I send you a PayPal link?"], ["customer", "Yes please, I'll pay it now."], ["agent", "Done. Thanks, see you this afternoon."]], "paid");
  const benC = await extra("Ben Carter", "+61 491 570 161", "ben@example.com");
  const ben = await oblig(benC, "invoice", "Invoice #1058: 2 reformer classes", 8000, addDays(clock, -9), null);
  await sampleCall(benC, ben, "chase_invoice", 70, [["agent", "Hi Ben, a quick one from Brightside: invoice #1058 for $80 is nine days past due. Would a PayPal link help?"], ["customer", "Sorry, forgot. Send it and I'll pay straight away."], ["agent", "Sent. Thank you, Ben."]], "paid");
  const ivyC = await extra("Ivy Park", "+61 491 570 162", "ivy@example.com");
  const ivy = await oblig(ivyC, "invoice", "Invoice #1060: 10-class reformer pack", 36000, addDays(clock, -8), null);
  const ivyCall = await sampleCall(ivyC, ivy, "chase_invoice", 40, [["agent", "Hi Ivy, it's Brightside's assistant about invoice #1060 for the 10-class pack, $360, now a week overdue."], ["customer", "I can pay it today if you send me the PayPal link."], ["agent", "That's over the amount I can send without Maya's OK, so I've asked her. You'll get the link as soon as she approves."]], "held_for_owner");
  // The hold is made by the real gate: a $360 link is over the studio's $300 limit, so it waits for the owner.
  const run = await startRun({ actor: "agent", subject: "Sample call: Ivy Park asked for her pay link", entity: "call", entityId: ivyCall }, db);
  const biz = await bizById(db, bizId);
  try {
    await sendPayLink({ q: db, run, businessId: bizId, businessName: biz.name, callId: ivyCall, agentScope: `agent:${ivyCall}` }, await obligationById(db, ivy), await customerById(db, ivyC));
  } catch (e) {
    if (!(e instanceof HeldForApproval)) throw e;
  }
  await run.end("done");
  await planCalls(db, bizId, "demo", clock);
  // The three items the seed pays from the saved wallet right after the page opens are not called meanwhile; the
  // re-plan after those payments brings a call back for any payment that failed.
  if (config.paypal.demoVaultToken) await db.query("UPDATE calls SET status = 'skipped', reason = $2, ended_at = now() WHERE obligation_id = ANY($1::text[]) AND status IN ('planned','blocked')", [[seeded.obligations.tom_class, aisha, ben], "not needed now: being paid from the saved demo wallet"]);
  await db.query("INSERT INTO settings (key, value) VALUES ('demo_keys', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify({ owner: seeded.ownerKey, staff: seeded.staffKey })]);
  return { ...seeded, samples: { aisha, ben, ivyCall } };
}

/** The seed's real money: Tom's class booking and the two deposits paid on the sample calls, from the saved wallet. */
async function seedPayments(db: Db, id: string | null, seeded: WorkspaceSeed) {
  if (!config.paypal.demoVaultToken) return;
  const biz = await bizById(db, seeded.business.id);
  const jobs: { obl: string; booking: boolean; label: string }[] = [
    { obl: seeded.obligations.tom_class, booking: true, label: "Tom's class booking" },
    { obl: seeded.samples.aisha, booking: false, label: "Aisha's deposit" },
    { obl: seeded.samples.ben, booking: false, label: "Ben's invoice" },
  ];
  let done = 0;
  const failed: string[] = [];
  for (const [k, j] of jobs.entries()) {
    const run = await startRun({ actor: "system", subject: `Seed: ${j.label} paid from the saved demo wallet`, entity: "obligation", entityId: j.obl }, db);
    try {
      const o = await obligationById(db, j.obl);
      await payFromDemoWallet({ q: db, run, businessId: biz.id, businessName: biz.name, callId: null, agentScope: "customer:demo-wallet", personInitiated: true }, o, await customerById(db, o.customer_id), { booking: j.booking });
      if (!j.booking) await db.query("UPDATE calls SET collected_cents = $2 WHERE obligation_id = $1 AND is_sample", [o.id, o.amount_cents]);
      done++;
      await run.end("done");
    } catch (e) {
      failed.push(`${j.label}: ${(e as Error).message.slice(0, 120)}`);
      await run.end("failed");
    }
    const note = `${done} of ${jobs.length} payments confirmed by PayPal${k < jobs.length - 1 ? " so far…" : ""}${failed.length ? `; not made: ${failed.join("; ")}` : ""}`;
    if (id) {
      await registry((r) => r.query("UPDATE workspaces SET seed_note = $2 WHERE id = $1", [id, note]));
      cache.delete(id);
    } else await db.query("INSERT INTO settings (key, value) VALUES ('showcase_note', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [note]);
  }
  await logEvent(db, { businessId: biz.id, type: "seed.payments", summary: `${done} of ${jobs.length} seed payments made from the saved demo wallet and read back from PayPal`, actor: "system" });
  // The plan was written before these payments: re-plan so no call waits on an item that is now paid.
  await planCalls(db, biz.id, "demo");
}

/**
 * The showcase studio (spec A1.2): the app's own schema, read-only to visitors (nobody signs into it), feeding the
 * landing page's live preview. Rebuilt through the same seeding path as a visitor's workspace, at boot when missing
 * and every 24 hours by the worker, so it never decays.
 */
export async function rebuildShowcase(): Promise<void> {
  const db = await getDb();
  await inWorkspace(null, async () => {
    for (const t of APP_TABLES) await db.query(`DELETE FROM ${t}`);
    const seeded = await seedWorkspace(db, null);
    await db.query("INSERT INTO settings (key, value) VALUES ('showcase_built_at', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [new Date().toISOString()]);
    void seedPayments(db, null, seeded).catch((e) => console.error("[showcase] seed payments", (e as Error).message));
  });
}

/** True when the showcase is missing or older than a day. */
export async function showcaseStale(): Promise<boolean> {
  const db = await getDb();
  return inWorkspace(null, async () => {
    const biz = (await db.query("SELECT 1 FROM businesses LIMIT 1")).rows.length;
    const at = (await db.query<{ value: string }>("SELECT value FROM settings WHERE key = 'showcase_built_at'")).rows[0]?.value;
    return !biz || !at || Date.now() - new Date(at).getTime() > 24 * 3600_000;
  });
}

/** Voids nothing today: the seed and the agent only create CAPTURE orders and links. Kept as the hook for holds (Wave 3). */
async function voidOpenHolds(_id: string) {
  return 0;
}

export async function removeWorkspace(id: string, why: string) {
  const db = await getDb();
  await voidOpenHolds(id);
  await dropWorkspaceSchema(db, id);
  await registry(async (r) => {
    await r.query("DELETE FROM ws_refs WHERE ws_id = $1", [id]);
    await r.query("DELETE FROM workspaces WHERE id = $1", [id]);
  });
  cache.delete(id);
  console.log(`[workspace ${id}] removed: ${why}`);
}

/** Idle expiry: workspaces not visited for CB_WORKSPACE_IDLE_HOURS are dropped with everything in them. */
export async function expireWorkspaces(): Promise<number> {
  const gone = await registry((db) => db.query<{ id: string }>("SELECT id FROM workspaces WHERE kind = 'visitor' AND expires_at < now()"));
  for (const w of gone.rows) await removeWorkspace(w.id, "idle");
  await registry((db) => db.query("DELETE FROM ws_starts WHERE at < now() - interval '1 day'"));
  return gone.rows.length;
}

/** Workspaces the worker should tick: ready, not expired, most recently seen first. */
export async function liveWorkspaces(): Promise<{ id: string; last_seen_at: Date }[]> {
  return (await registry((db) => db.query<{ id: string; last_seen_at: Date }>("SELECT id, last_seen_at FROM workspaces WHERE seed_state = 'ready' AND expires_at > now() ORDER BY last_seen_at DESC"))).rows;
}

export async function workspaceByJoinToken(token: string): Promise<Workspace | null> {
  const r = (await registry((db) => db.query<any>("SELECT * FROM workspaces WHERE join_token = $1 AND expires_at > now()", [token]))).rows[0];
  return r ? row(r) : null;
}
