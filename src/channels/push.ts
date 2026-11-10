/** Web push for the Callback owner PWA (roadmap B.8). VAPID keys from env; without them, pushes are recorded as simulated. */
import type { Party } from "./index.js";
import { config } from "../config.js";
import { getDb, type Queryable } from "../db.js";
import { enqueue } from "../jobs.js";
import { newId } from "../lib/ids.js";

export const pushReady = () => Boolean(config.channels.vapidPublic && config.channels.vapidPrivate);

export async function subscribe(party: Party, partyId: string, subscription: unknown) {
  const db = await getDb();
  await db.query("INSERT INTO push_subscriptions (id, party, party_id, subscription) VALUES ($1,$2,$3,$4)", [newId("push"), party, partyId, JSON.stringify(subscription)]);
}

export async function pushTo(party: Party, partyId: string, payload: { title: string; body: string; url?: string }, q?: Queryable) {
  const db = q ?? (await getDb());
  const subs = (await db.query<{ id: string }>("SELECT id FROM push_subscriptions WHERE party = $1 AND party_id = $2", [party, partyId])).rows;
  for (const s of subs) await enqueue(db, "send_push", { subscriptionId: s.id, payload }, new Date(), `push:${s.id}:${Date.now()}`);
  await db.query("INSERT INTO channel_messages (id, channel, direction, address, body, status) VALUES ($1,'push','out',$2,$3,$4)", [newId("msg"), `${party}:${partyId}`, `${payload.title}: ${payload.body}`, subs.length && pushReady() ? "queued" : "simulated"]);
}

export async function sendPush(subscriptionId: string, payload: { title: string; body: string; url?: string }) {
  if (!pushReady()) return;
  const db = await getDb();
  const row = (await db.query<{ subscription: any; party: string; party_id: string }>("SELECT subscription, party, party_id FROM push_subscriptions WHERE id = $1", [subscriptionId])).rows[0];
  if (!row) return;
  // Every send leaves a row saying what the push service answered: a silently removed subscription looked "done"
  // on 10 Nov 2026 while nothing was delivered.
  const note = (status: string, body: string) =>
    db.query("INSERT INTO channel_messages (id, channel, direction, address, body, status) VALUES ($1,'push','out',$2,$3,$4)", [newId("msg"), `${row.party}:${row.party_id}`, body.slice(0, 300), status]);
  const sub = typeof row.subscription === "string" ? JSON.parse(row.subscription) : row.subscription;
  // web-push is CommonJS: depending on the loader its functions sit on the namespace or on .default. Reading only
  // .default crashed every send ("reading 'setVapidDetails'"), so no push ever went out before 10 Nov 2026.
  const mod: any = await import("web-push");
  const webpush = mod.default?.sendNotification ? mod.default : mod;
  webpush.setVapidDetails(`mailto:ops@${new URL(config.appUrl).hostname}`, config.channels.vapidPublic, config.channels.vapidPrivate);
  try {
    const res = await webpush.sendNotification(sub, JSON.stringify(payload));
    await note("sent", `Delivered to the push service (${res?.statusCode ?? "ok"}): ${payload.title}: ${payload.body}`);
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.statusCode === 410) {
      await db.query("DELETE FROM push_subscriptions WHERE id = $1", [subscriptionId]);
      await note("failed", `This device's alert subscription has expired (${e.statusCode}) and was removed. Turn alerts on again on that device.`);
    } else {
      await note("failed", `Push service refused (${e?.statusCode ?? "error"}): ${String(e?.body ?? e?.message ?? "").slice(0, 160)}`);
      throw e;
    }
  }
}
