/**
 * Worker jobs: plan_calls (each business, each tick), read_back (PayPal is the truth for what was paid), channel
 * sends, web push, callback_due (a planned callback re-enters the call list when its time comes).
 */
import { deliver } from "./channels/index.js";
import { sendPush } from "./channels/push.js";
import type { Db } from "./db.js";
import { getDb } from "./db.js";
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

/** Queues the periodic jobs and runs what is due. */
export async function tick(db: Db, now = new Date()): Promise<number> {
  await enqueue(db, "plan_calls", {}, now, "plan_calls:tick");
  await enqueue(db, "read_back", {}, now, "read_back:tick");
  for (const cb of (await db.query<{ id: string }>("SELECT id FROM callbacks WHERE status = 'scheduled' AND at <= $1", [now.toISOString()])).rows) await enqueue(db, "callback_due", { callbackId: cb.id }, now, `cb:${cb.id}`);
  return runDueJobs(db, handlers, 50, now);
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
