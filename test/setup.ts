import { installChannelHandlers } from "../src/channels/handlers.js";
import { config } from "../src/config.js";
import { openDb, setDb, type Db } from "../src/db.js";
import { FakePayPal } from "../src/paypal/fake.js";
import { setPayPal } from "../src/paypal/index.js";
import { planCalls } from "../src/services/planner.js";
import { seedDemo, type Seeded } from "../src/services/seed.js";

/** Wednesday 13:00 in Sydney. */
export const NOW = new Date("2026-03-04T02:00:00Z");

export async function freshWorld(opts: { plan?: boolean } = {}): Promise<{ db: Db; fake: FakePayPal; seeded: Seeded }> {
  installChannelHandlers();
  (config.ai as any).provider = "none";
  const db = await openDb({ memory: true });
  setDb(db);
  const fake = new FakePayPal();
  setPayPal(fake);
  const seeded = await seedDemo(db, { now: NOW, pinClock: true });
  if (opts.plan !== false) await planCalls(db, seeded.business.id, "test", NOW);
  return { db, fake, seeded };
}

export async function callFor(db: Db, obligationId: string): Promise<string> {
  const r = (await db.query<{ id: string }>("SELECT id FROM calls WHERE obligation_id = $1 ORDER BY created_at DESC LIMIT 1", [obligationId])).rows[0];
  if (!r) throw new Error(`no call for ${obligationId}`);
  return r.id;
}
