import { afterEach, beforeEach, expect, it } from "vitest";
import { config } from "../src/config.js";
import { openDb, setDb, type Db } from "../src/db.js";
import { routeOf, routeTelegram, setRouterFetch } from "../src/channels/router.js";

// One bot, eight apps: a chat picks its app by deep link or menu, and later messages are forwarded there with the secret.
let db: Db;
let calls: { url: string; body: any; secret: string | null }[];
const saved = { ...config.channels };
beforeEach(async () => {
  db = await openDb({ memory: true });
  setDb(db);
  calls = [];
  config.channels.telegramToken = "123:abc";
  config.channels.telegramSecret = "s3cret";
  setRouterFetch((async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body), secret: init.headers["x-telegram-bot-api-secret-token"] ?? null });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as any);
});
afterEach(async () => {
  Object.assign(config.channels, saved);
  setRouterFetch(null);
  await db.close();
});
const upd = (text: string, chat = 42) => ({ update_id: 1, message: { message_id: 1, chat: { id: chat }, from: { id: chat }, text } });

it("deep link routes the chat and forwards /start with the code; later messages follow; Callback stays local", async () => {
  const local: any[] = [];
  expect(await routeTelegram(upd("/start everyday-AB12CD"), async (u) => local.push(u))).toBe("everyday");
  const fwd = calls.find((c) => c.url.includes("pph-everyday"))!;
  expect(fwd.body.message.text).toBe("/start AB12CD");
  expect(fwd.secret).toBe("s3cret");
  expect(await routeOf("42")).toBe("everyday");
  expect(await routeTelegram(upd("yes please"), async (u) => local.push(u))).toBe("everyday");
  expect(calls.filter((c) => c.url.includes("pph-everyday")).length).toBe(2);
  expect(await routeTelegram(upd("/start callback", 7), async (u) => local.push(u))).toBe("callback");
  expect(local.length).toBe(1);
});

it("an unknown chat talks to Callback; /switch shows the menu; picking one routes it", async () => {
  const local: any[] = [];
  expect(await routeTelegram(upd("hello", 9), async (u) => local.push(u))).toBe("callback");
  expect(local.length).toBe(1);
  expect(await routeOf("9")).toBe("callback");
  expect(await routeTelegram(upd("/switch", 9), async () => undefined)).toBe("menu");
  expect(calls.some((c) => c.url.endsWith("/sendMessage") && c.body.reply_markup?.inline_keyboard)).toBe(true);
  expect(await routeTelegram({ update_id: 2, callback_query: { id: "q", data: "route:makegood", message: { chat: { id: 9 } } } }, async () => undefined)).toBe("menu:makegood");
  expect(await routeOf("9")).toBe("makegood");
  expect(await routeTelegram(upd("/switch", 9), async () => undefined)).toBe("menu");
});
