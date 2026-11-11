/** Workspace helpers with no service imports (used by the money service, channels and webhooks). */
import { AsyncLocalStorage } from "node:async_hooks";
import { currentWs, getDb, inWorkspace, WS_ID } from "../db.js";

/** Lets the registry cache in workspaces.ts drop an entry without an import cycle. */
export const cacheDrop: { fn: (id: string) => void } = { fn: () => undefined };

/** A secret (customer link token, access key, Telegram code) names its workspace: `cbt_w<ws>_<random>`. */
export function wsFromSecret(s: string | null | undefined): string | null {
  const m = /^cb[a-z]_w([a-z0-9]{10})_/.exec(String(s ?? "")) ?? /^([a-z0-9]{10})Z/.exec(String(s ?? ""));
  return m && WS_ID.test(m[1]) ? m[1] : null;
}
/** custom_id on every PayPal object made inside a workspace: "<ws>:<record id>", read back by the webhook handler. */
export const wsCustomId = (id: string) => (currentWs() ? `${currentWs()}:${id}` : id);
export function splitCustomId(s: string | null | undefined): { ws: string | null; id: string } {
  const m = /^([a-z0-9]{10}):(.+)$/.exec(String(s ?? ""));
  return m ? { ws: m[1], id: m[2] } : { ws: null, id: String(s ?? "") };
}

/** Records which workspace an outside id (PayPal order, capture, invoice, subscription; a Telegram chat; a call) belongs to. */
export async function noteRef(kind: string, ref: string | null | undefined) {
  const ws = currentWs();
  if (!ws || !ref) return;
  const db = await getDb();
  await inWorkspace(null, () => db.query("INSERT INTO ws_refs (ref, ws_id, kind) VALUES ($1,$2,$3) ON CONFLICT (ref) DO UPDATE SET ws_id = EXCLUDED.ws_id, kind = EXCLUDED.kind", [ref, ws, kind]));
}
export async function wsForRef(ref: string | null | undefined): Promise<string | null> {
  if (!ref) return null;
  const db = await getDb();
  return (await inWorkspace(null, () => db.query<{ ws_id: string }>("SELECT ws_id FROM ws_refs WHERE ref = $1", [ref]))).rows[0]?.ws_id ?? null;
}

/** Code run inside quietSteps.run(true, …) (the seed, which places a held charge and sample calls) ticks nothing. */
export const quietSteps = new AsyncLocalStorage<boolean>();

/** Ticks a judge-path step on the workspace's checklist (spec A3.1), once, with the time it happened. Only what the
 * visitor does counts: the seed's own calls and holds are made inside quietSteps. */
export async function markStep(step: string) {
  const ws = currentWs();
  if (!ws || quietSteps.getStore()) return;
  const db = await getDb();
  const r = await inWorkspace(null, () => db.query("UPDATE workspaces SET checklist = checklist || jsonb_build_object($2::text, now()::text) WHERE id = $1 AND NOT (checklist ? $2) RETURNING id", [ws, step]));
  if (r.rows.length) cacheDrop.fn(ws); // already ticked: nothing changed, keep the cache
}

