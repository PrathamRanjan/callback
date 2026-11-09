import type { Db, Queryable } from "./db.js";

export type JobType = "plan_calls" | "read_back" | "send_channel_message" | "send_push" | "callback_due";

export async function enqueue(q: Queryable, type: JobType, payload: Record<string, unknown>, runAt: Date = new Date(), dedupeKey?: string) {
  if (dedupeKey) {
    await q.query(
      `INSERT INTO jobs_queue (type, payload, run_at, dedupe_key) VALUES ($1,$2,$3,$4)
       ON CONFLICT (dedupe_key) DO UPDATE SET payload = EXCLUDED.payload, run_at = EXCLUDED.run_at,
         status = 'pending', attempts = 0, last_error = NULL, updated_at = now()`,
      [type, JSON.stringify(payload), runAt, dedupeKey],
    );
  } else {
    await q.query("INSERT INTO jobs_queue (type, payload, run_at) VALUES ($1,$2,$3)", [type, JSON.stringify(payload), runAt]);
  }
}

export type Handler = (payload: any) => Promise<void>;

/** Runs due jobs one at a time. A failed job retries with backoff, up to 5 attempts, then stays `failed` for a person. */
export async function runDueJobs(db: Db, handlers: Record<JobType, Handler>, limit = 25, now: Date = new Date()): Promise<number> {
  const due = (await db.query<{ id: number; type: JobType; payload: any; attempts: number }>("SELECT id, type, payload, attempts FROM jobs_queue WHERE status = 'pending' AND run_at <= $1 ORDER BY run_at, id LIMIT $2", [now, limit])).rows;
  let ran = 0;
  for (const job of due) {
    const claimed = await db.query("UPDATE jobs_queue SET status = 'running', attempts = attempts + 1, updated_at = now() WHERE id = $1 AND status = 'pending' RETURNING id", [job.id]);
    if (!claimed.rows.length) continue;
    try {
      const h = handlers[job.type];
      if (!h) throw new Error(`No handler for job type ${job.type}`);
      await h(typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload);
      await db.query("UPDATE jobs_queue SET status = 'done', updated_at = now() WHERE id = $1 AND status = 'running'", [job.id]);
    } catch (e) {
      const attempts = job.attempts + 1;
      await db.query("UPDATE jobs_queue SET status = $2, last_error = $3, run_at = $4, updated_at = now() WHERE id = $1", [job.id, attempts >= 5 ? "failed" : "pending", String((e as Error).message ?? e).slice(0, 500), new Date(Date.now() + 15_000 * 2 ** attempts)]);
    }
    ran++;
  }
  return ran;
}

/** Runs everything that is due now, repeatedly, until the queue is quiet. Used by tests and scripts. */
export async function drain(db: Db, handlers: Record<JobType, Handler>, maxRounds = 20, now?: Date): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxRounds; i++) {
    const n = await runDueJobs(db, handlers, 50, now ?? new Date());
    total += n;
    if (!n) break;
  }
  return total;
}
