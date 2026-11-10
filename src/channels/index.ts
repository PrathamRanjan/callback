/**
 * Channels (roadmap B.8): SMS (Twilio) for the pay link mid-call, Telegram and WhatsApp Cloud API with reply buttons,
 * an in-app simulator so the demo runs without a phone, and web push for the owner's PWA. Outbound messages are
 * queued in channel_messages and sent by the worker; inbound messages are matched to a customer or the owner by
 * party_links. Customers are addressed by their status token (party "customer"); the owner by business id.
 */
import { config, mayContactForReal } from "../config.js";
import type { Queryable } from "../db.js";
import { getDb } from "../db.js";
import { enqueue } from "../jobs.js";
import { newId } from "../lib/ids.js";
import { pushTo } from "./push.js";

export type Party = "customer" | "owner";
export type Channel = "sms" | "telegram" | "whatsapp" | "simulator";
export interface Button {
  id: string;
  label: string;
}

let fetchImpl: typeof fetch = (i, init) => fetch(i, init);
export function setChannelFetch(f: typeof fetch | null) {
  fetchImpl = f ?? ((i, init) => fetch(i, init));
}

export const telegramReady = () => Boolean(config.channels.telegramToken);
export const whatsappReady = () => Boolean(config.channels.whatsappToken && config.channels.whatsappPhoneId);
export const smsReady = () => Boolean(config.voice.twilioSid && config.voice.twilioToken && config.voice.twilioFrom);

/** Queue a message to an address; delivered by the send_channel_message job. */
export async function send(opts: { channel: Channel; address: string; body: string; buttons?: Button[]; entity?: string; entityId?: string }, q?: Queryable): Promise<string> {
  const db = q ?? (await getDb());
  const id = newId("msg");
  await db.query("INSERT INTO channel_messages (id, channel, direction, address, body, buttons, entity, entity_id, status) VALUES ($1,$2,'out',$3,$4,$5,$6,$7,'queued')", [id, opts.channel, opts.address, opts.body, opts.buttons ? JSON.stringify(opts.buttons) : null, opts.entity ?? null, opts.entityId ?? null]);
  await enqueue(db, "send_channel_message", { messageId: id }, new Date(), `chan:${id}`);
  return id;
}

/** Sends to every channel a party has linked (plus the simulator). */
export async function notifyParty(party: Party, partyId: string, body: string, buttons?: Button[], entity?: string, entityId?: string, q?: Queryable) {
  const db = q ?? (await getDb());
  const links = (await db.query<{ channel: Channel; address: string }>("SELECT channel, address FROM party_links WHERE party = $1 AND party_id = $2", [party, partyId])).rows;
  const targets = links.length ? links : [{ channel: "simulator" as Channel, address: `${party}:${partyId}` }];
  if (links.length && !links.some((l) => l.channel === "simulator")) targets.push({ channel: "simulator", address: `${party}:${partyId}` });
  for (const t of targets) await send({ channel: t.channel, address: t.address, body, buttons, entity, entityId }, db);
  // The owner also gets a push on any device where they turned on alerts (Messages > Alerts on this device).
  if (party === "owner") await pushTo("owner", partyId, { title: "Callback", body, url: entity === "approval" ? "/approvals" : "/today" }, db);
}

/** The pay link a customer gets mid-call: by SMS to their phone when Twilio is set, always mirrored to the simulator. */
export async function textCustomer(customer: { token: string; phone: string }, body: string, entity?: string, entityId?: string, q?: Queryable) {
  const db = q ?? (await getDb());
  await send({ channel: "sms", address: customer.phone, body, entity, entityId }, db);
  await send({ channel: "simulator", address: `customer:${customer.token}`, body, entity, entityId }, db);
}

export async function deliver(messageId: string): Promise<void> {
  const db = await getDb();
  const m = (await db.query("SELECT * FROM channel_messages WHERE id = $1 AND direction = 'out' AND status = 'queued'", [messageId])).rows[0] as any;
  if (!m) return;
  const buttons: Button[] = m.buttons ?? [];
  try {
    let externalId: string | null = null;
    if (m.channel === "sms" && smsReady() && mayContactForReal(m.address)) {
      const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${config.voice.twilioSid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: "Basic " + Buffer.from(`${config.voice.twilioSid}:${config.voice.twilioToken}`).toString("base64"), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: m.address, From: config.voice.twilioFrom, Body: m.body }).toString(),
      });
      const data = (await res.json()) as any;
      if (!res.ok) throw new Error(`Twilio SMS: ${data.message ?? res.status}`);
      externalId = data.sid ?? null;
    } else if (m.channel === "telegram" && telegramReady()) {
      const res = await fetchImpl(`https://api.telegram.org/bot${config.channels.telegramToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: m.address, text: m.body, reply_markup: buttons.length ? { inline_keyboard: [buttons.map((b) => ({ text: b.label, callback_data: `${m.id}:${b.id}` }))] } : undefined }),
      });
      const data = (await res.json()) as any;
      if (!data.ok) throw new Error(`Telegram: ${data.description ?? res.status}`);
      externalId = String(data.result?.message_id ?? "");
    } else if (m.channel === "whatsapp" && whatsappReady()) {
      const payload = buttons.length
        ? { messaging_product: "whatsapp", to: m.address, type: "interactive", interactive: { type: "button", body: { text: m.body }, action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: `${m.id}:${b.id}`, title: b.label.slice(0, 20) } })) } } }
        : { messaging_product: "whatsapp", to: m.address, type: "text", text: { body: m.body } };
      const res = await fetchImpl(`https://graph.facebook.com/v21.0/${config.channels.whatsappPhoneId}/messages`, { method: "POST", headers: { Authorization: `Bearer ${config.channels.whatsappToken}`, "content-type": "application/json" }, body: JSON.stringify(payload) });
      const data = (await res.json()) as any;
      if (!res.ok) throw new Error(`WhatsApp: ${data.error?.message ?? res.status}`);
      externalId = data.messages?.[0]?.id ?? null;
    } else if (m.channel !== "simulator") {
      await db.query("UPDATE channel_messages SET status = 'simulated' WHERE id = $1", [messageId]);
      return;
    }
    await db.query("UPDATE channel_messages SET status = 'sent', external_id = $2 WHERE id = $1", [messageId, externalId]);
  } catch (e) {
    await db.query("UPDATE channel_messages SET status = 'failed' WHERE id = $1", [messageId]);
    throw e;
  }
}

export type InboundHandler = (msg: { channel: Channel; address: string; text: string; buttonId: string | null; replyTo: string | null; party: { party: string; party_id: string } | null }) => Promise<string | null>;
let inboundHandler: InboundHandler | null = null;
export function onInbound(h: InboundHandler) {
  inboundHandler = h;
}

/** Records an inbound message, resolves the party, runs the app's handler and queues its reply. */
export async function receive(channel: Channel, address: string, text: string, buttonId: string | null, replyTo: string | null): Promise<string | null> {
  const db = await getDb();
  const id = newId("msg");
  await db.query("INSERT INTO channel_messages (id, channel, direction, address, body, buttons, status) VALUES ($1,$2,'in',$3,$4,$5,'received')", [id, channel, address, text, buttonId ? JSON.stringify([{ id: buttonId, label: buttonId }]) : null]);
  const party = (await db.query<{ party: string; party_id: string }>("SELECT party, party_id FROM party_links WHERE channel = $1 AND address = $2", [channel, address])).rows[0] ?? null;
  const reply = inboundHandler ? await inboundHandler({ channel, address, text, buttonId, replyTo, party }) : null;
  if (reply) await send({ channel, address, body: reply }, db);
  return reply;
}

export async function link(channel: Channel, address: string, party: Party, partyId: string) {
  const db = await getDb();
  await db.query("INSERT INTO party_links (id, channel, address, party, party_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (channel, address) DO UPDATE SET party = EXCLUDED.party, party_id = EXCLUDED.party_id", [newId("lnk"), channel, address, party, partyId]);
}

export async function conversation(address: string, limit = 50) {
  const db = await getDb();
  return (await db.query("SELECT * FROM channel_messages WHERE address = $1 ORDER BY created_at DESC LIMIT $2", [address, limit])).rows.reverse() as any[];
}

export async function recentMessages(limit = 100) {
  const db = await getDb();
  return (await db.query("SELECT * FROM channel_messages ORDER BY created_at DESC LIMIT $1", [limit])).rows as any[];
}

/** Telegram webhook body -> receive(). */
export async function telegramUpdate(update: any): Promise<void> {
  if (update.callback_query) {
    const cq = update.callback_query;
    // callback_data is "<message id>:<button id>", and button ids hold colons themselves ("approve:apr_x"), so split once.
    const data = String(cq.data ?? "");
    const cut = data.indexOf(":");
    const replyTo = cut > 0 ? data.slice(0, cut) : null;
    const buttonId = cut > 0 ? data.slice(cut + 1) : data || null;
    await receive("telegram", String(cq.message?.chat?.id ?? cq.from?.id), data, buttonId, replyTo);
    return;
  }
  const msg = update.message;
  if (msg?.text) await receive("telegram", String(msg.chat.id), msg.text, null, null);
}

/** WhatsApp Cloud API webhook body -> receive(). */
export async function whatsappUpdate(body: any): Promise<void> {
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value?.messages ?? []) {
        if (m.type === "interactive" && m.interactive?.button_reply) {
          const bid = String(m.interactive.button_reply.id);
          const cut = bid.indexOf(":");
          const [replyTo, buttonId] = cut > 0 ? [bid.slice(0, cut), bid.slice(cut + 1)] : [null, bid];
          await receive("whatsapp", m.from, m.interactive.button_reply.title ?? "", buttonId ?? null, replyTo ?? null);
        } else if (m.type === "text") await receive("whatsapp", m.from, m.text?.body ?? "", null, null);
      }
    }
  }
}

/** Twilio inbound SMS webhook (form-encoded) -> receive(). "STOP" revokes consent via the handler. */
export async function smsUpdate(body: any): Promise<void> {
  if (body?.From && typeof body.Body === "string") await receive("sms", String(body.From), body.Body, null, null);
}
