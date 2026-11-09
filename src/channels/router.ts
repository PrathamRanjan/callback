/**
 * One Telegram bot for all eight apps. Telegram delivers a bot's updates to a single web address, which is Callback's,
 * so Callback routes each chat to the app it is talking to and forwards the update unchanged (same secret header).
 * A chat picks its app with a deep link (t.me/<bot>?start=<app> or ?start=<app>-<code>), the menu, or /switch.
 * Outbound messages need no routing: every app sends with the same bot token.
 */
import { config } from "../config.js";
import { getDb } from "../db.js";

export const TG_APPS: Record<string, string> = {
  desk: "Business Desk", callback: "Callback", backon: "BackOn", stocksure: "StockSure",
  kept: "Kept", everyday: "Everyday", groundtruth: "Groundtruth", makegood: "MakeGood",
};
const HINT: Record<string, string> = {
  desk: "Send: link owner:<your access key> (owners) or link customer:<your status-page token>.",
  callback: "Send: link owner:<your access key>, or open your customer page for your link.",
  backon: "Open your booking page and tap Connect Telegram, or send your booking reference.",
  stocksure: "Open StockSure, Settings, Telegram, and send the code shown there.",
  kept: "Open your subscription page and tap Connect Telegram.",
  everyday: "Open Everyday, You, Telegram, and send /start with the code shown there.",
  groundtruth: "Open Groundtruth, Work, Telegram, and send the code shown there.",
  makegood: "Open your booking page and tap Connect Telegram.",
};

let fetchImpl: typeof fetch = (i, init) => fetch(i, init);
export function setRouterFetch(f: typeof fetch | null) {
  fetchImpl = f ?? ((i, init) => fetch(i, init));
}
const appUrl = (app: string) => (process.env[`TG_ROUTE_${app.toUpperCase()}`] || `https://pph-${app}.onrender.com`) + "/webhooks/telegram";

async function tg(method: string, body: unknown) {
  if (!config.channels.telegramToken) return;
  await fetchImpl(`https://api.telegram.org/bot${config.channels.telegramToken}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
}
async function menu(chatId: string, intro: string) {
  const names = Object.entries(TG_APPS);
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < names.length; i += 2) rows.push(names.slice(i, i + 2).map(([k, n]) => ({ text: n, callback_data: `route:${k}` })));
  await tg("sendMessage", { chat_id: chatId, text: intro, reply_markup: { inline_keyboard: rows } });
}

async function table() {
  const db = await getDb();
  await db.query("CREATE TABLE IF NOT EXISTS tg_routes (chat_id TEXT PRIMARY KEY, app TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now())");
  return db;
}
export async function routeOf(chatId: string): Promise<string | null> {
  const db = await table();
  return ((await db.query<{ app: string }>("SELECT app FROM tg_routes WHERE chat_id = $1", [chatId])).rows[0]?.app) ?? null;
}
async function setRoute(chatId: string, app: string) {
  const db = await table();
  await db.query("INSERT INTO tg_routes (chat_id, app) VALUES ($1,$2) ON CONFLICT (chat_id) DO UPDATE SET app = EXCLUDED.app, at = now()", [chatId, app]);
}

async function forward(app: string, update: any) {
  const res = await fetchImpl(appUrl(app), { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": config.channels.telegramSecret }, body: JSON.stringify(update), signal: AbortSignal.timeout(60_000) }).catch((e) => e as Error);
  if (res instanceof Error || !res.ok) throw new Error(`forward to ${app} failed: ${res instanceof Error ? res.message : res.status}`);
}

/** Routes one Telegram update. `local` handles updates for Callback itself. Returns where it went (for tests and the trace). */
export async function routeTelegram(update: any, local: (u: any) => Promise<unknown>): Promise<string> {
  const msg = update?.message ?? update?.edited_message;
  const cb = update?.callback_query;
  const chatId = String(msg?.chat?.id ?? cb?.message?.chat?.id ?? "");
  if (!chatId) {
    await local(update);
    return "callback";
  }
  if (typeof cb?.data === "string" && cb.data.startsWith("route:")) {
    const app = cb.data.slice(6);
    if (!TG_APPS[app]) return "ignored";
    await setRoute(chatId, app);
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: `Connected to ${TG_APPS[app]}` });
    await tg("sendMessage", { chat_id: chatId, text: `You're talking to ${TG_APPS[app]}. ${HINT[app]}\nSend /switch at any time to pick another app.` });
    return `menu:${app}`;
  }
  const text = String(msg?.text ?? "").trim();
  if (/^\/(switch|apps)\b/i.test(text)) {
    await menu(chatId, "Which app do you want to talk to?");
    return "menu";
  }
  const start = text.match(/^\/start(?:\s+([a-z]+)(?:[-_](\S+))?)?\s*$/i);
  if (start?.[1] && TG_APPS[start[1].toLowerCase()]) {
    const app = start[1].toLowerCase();
    await setRoute(chatId, app);
    const rewritten = { ...update, message: { ...msg, text: start[2] ? `/start ${start[2]}` : "/start" } };
    if (app === "callback") await local(rewritten);
    else await forward(app, rewritten);
    if (!start[2]) await tg("sendMessage", { chat_id: chatId, text: `Connected to ${TG_APPS[app]}. ${HINT[app]}` });
    return app;
  }
  const app = await routeOf(chatId);
  if (!app) {
    await menu(chatId, "Hi! This bot serves eight PayPal hackathon apps. Which one are you using?");
    return "menu";
  }
  if (app === "callback") await local(update);
  else await forward(app, update);
  return app;
}
