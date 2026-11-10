/**
 * Worker jobs: plan_calls (each business, each tick), read_back (PayPal is the truth for what was paid), channel
 * sends, web push, callback_due (a planned callback re-enters the call list when its time comes).
 */
import { deliver } from "./channels/index.js";
import { sendPush } from "./channels/push.js";
import { config } from "./config.js";
import type { Db } from "./db.js";
import { getDb, inWorkspace } from "./db.js";
import { endCall } from "./services/calls.js";
import { expireWorkspaces, liveWorkspaces, rebuildShowcase, showcaseStale } from "./services/workspaces.js";
import { drain, enqueue, runDueJobs, type Handler, type JobType } from "./jobs.js";
import { paypalConfigured } from "./paypal/index.js";
import { readBack } from "./services/money.js";
import { planCalls } from "./services/planner.js";
import { nowOf } from "./store.js";
import { startRun } from "./trace.js";

export const handlers: Record<JobType, Handler> = {
  plan_calls: async (p) => {
    const db = await getDb();
    const now = p?.businessId ? await nowOf(db, p.businessId) : new Date();
    const bizs = p?.businessId ? [{ id: p.businessId }] : (await db.query<{ id: string }>("SELECT id FROM businesses")).rows;
    for (const b of bizs) await planCalls(db, b.id, "worker", p?.businessId ? now : await nowOf(db, b.id));
  },
  read_back: async (p) => {
    if (!paypalConfigured()) return;
    const db = await getDb();
    const bizs = p?.businessId ? [{ id: p.businessId }] : (await db.query<{ id: string }>("SELECT id FROM businesses")).rows;
    for (const b of bizs) {
      const run = await startRun({ actor: "worker", subject: "Read back PayPal state", entity: "business", entityId: b.id }, db);
      const changed = await readBack(db, b.id, run);
      await run.step({ actor: "code", tool: "read_back.done", result: { changed } });
      await run.end("done");
    }
  },
  send_channel_message: async (p) => deliver(p.messageId),
  send_push: async (p) => sendPush(p.subscriptionId, p.payload),
  callback_due: async (p) => {
    const db = await getDb();
    const cb = (await db.query<any>("SELECT * FROM callbacks WHERE id = $1 AND status = 'scheduled'", [p.callbackId])).rows[0];
    if (!cb) return;
    const prev = (await db.query<any>("SELECT * FROM calls WHERE id = $1", [cb.call_id])).rows[0];
    if (!prev) return;
    const { newId } = await import("./lib/ids.js");
    await db.query("INSERT INTO calls (id, business_id, customer_id, obligation_id, purpose, status, reason, scheduled_at) VALUES ($1,$2,$3,$4,$5,'planned',$6,$7)", [newId("call"), prev.business_id, prev.customer_id, prev.obligation_id, prev.purpose, `callback requested on ${cb.call_id}`, cb.at]);
    await db.query("UPDATE callbacks SET status = 'due' WHERE id = $1", [cb.id]);
  },
};

/** Periodic work runs on its own cadence per studio; due jobs run every tick. In-memory: a restart just runs them sooner. */
const lastRun = new Map<string, number>();
function due(key: string, everyMs: number, now: number): boolean {
  if (now - (lastRun.get(key) ?? 0) < everyMs) return false;
  lastRun.set(key, now);
  return true;
}

/**
 * A call left "on the line" with no new turn for 10 minutes (a closed tab, a dropped phone) ends as "abandoned"
 * (spec A4), so nobody else meets a stuck call and the planner can plan the next one.
 */
export async function endStuckCalls(db: Db, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 10 * 60_000).toISOString();
  const stuck = (await db.query<{ id: string }>("SELECT id FROM calls WHERE status IN ('in_progress','ringing') AND coalesce((transcript->-1->>'at')::timestamptz, started_at, created_at) < $1::timestamptz", [cutoff])).rows;
  for (const c of stuck) await endCall(db, c.id, "abandoned", "worker: no turn for 10 minutes");
  return stuck.length;
}

/** One studio's tick: plan (every 30 s), read back from PayPal (every 20 s), stuck calls (every minute), due jobs. */
async function tickOne(db: Db, key: string, now: Date): Promise<number> {
  const t = Date.now();
  if (due(`${key}:plan`, 30_000, t)) await enqueue(db, "plan_calls", {}, now, "plan_calls:tick");
  if (due(`${key}:read`, 20_000, t)) await enqueue(db, "read_back", {}, now, "read_back:tick");
  if (due(`${key}:stuck`, 60_000, t)) await endStuckCalls(db, now);
  for (const cb of (await db.query<{ id: string }>("SELECT id FROM callbacks WHERE status = 'scheduled' AND at <= $1", [now.toISOString()])).rows) await enqueue(db, "callback_due", { callbackId: cb.id }, now, `cb:${cb.id}`);
  return runDueJobs(db, handlers, 50, now);
}

/**
 * Queues the periodic jobs and runs what is due: the shared showcase studio, then each private workspace. A workspace
 * seen in the last 30 minutes is ticked every time; an idle one once a minute. Expired workspaces are removed.
 */
export async function tick(db: Db, now = new Date()): Promise<number> {
  let ran = await inWorkspace(null, () => tickOne(db, "base", now));
  if (!config.workspaces.enabled) return ran;
  const t = Date.now();
  if (due("expire", 10 * 60_000, t)) await expireWorkspaces().catch((e) => console.error("[worker] expire", (e as Error).message));
  if (due("showcase", 60 * 60_000, t) && (await showcaseStale())) await rebuildShowcase().catch((e) => console.error("[worker] showcase", (e as Error).message));
  for (const w of await liveWorkspaces()) {
    const idle = t - new Date(w.last_seen_at).getTime() > 30 * 60_000;
    if (idle && !due(`ws:${w.id}:idle`, 60_000, t)) continue;
    try {
      ran += await inWorkspace(w.id, () => tickOne(db, w.id, now));
    } catch (e) {
      console.error(`[worker] workspace ${w.id}`, (e as Error).message);
    }
  }
  return ran;
}

export async function drainAll(db: Db, now?: Date) {
  return drain(db, handlers, 20, now);
}

export function startInlineWorker(db: Db, intervalMs: number): () => void {
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await tick(db);
    } catch (e) {
      console.error("[worker]", (e as Error).message);
    } finally {
      busy = false;
    }
  }, intervalMs);
  t.unref?.();
  return () => clearInterval(t);
}
