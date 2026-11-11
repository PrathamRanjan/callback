/**
 * Wave 3 (spec B2): live voice on GPT-Live, the phone bridge, transcript decisions, owner listening, and the hold on
 * the call. A fake GPT-Live server stands in for OpenAI and a WebSocket client stands in for Twilio Media Streams;
 * the money runs on FakePayPal. Nothing here reaches OpenAI, Twilio or PayPal.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { config } from "../src/config.js";
import { createApp } from "../src/app.js";
import { setPayPal } from "../src/paypal/index.js";
import { attachVoiceBridge } from "../src/voice/bridge.js";
import { liveInstructions } from "../src/voice/live.js";
import { actionFor, SIGNAL_LINE } from "../src/voice/signals.js";
import { checkDialable, countryOf, normaliseNumber } from "../src/voice/limits.js";
import { setTelephonyFetch } from "../src/voice/telephony.js";
import { callFor, freshWorld } from "./setup.js";
import { Client } from "./client.js";

let world: Awaited<ReturnType<typeof freshWorld>>;
let server: http.Server;
let base: string;
let owner: Client;
const saved = { key: config.ai.openaiKey, url: config.ai.openaiBaseUrl, admin: config.adminKey, countries: [...config.voice.callMyPhoneCountries], sid: config.voice.twilioSid, tok: config.voice.twilioToken, from: config.voice.twilioFrom, secret: config.voice.webhookSecret, vault: config.paypal.demoVaultToken };

/* ---------- a fake GPT-Live: records what the app sends, and lets the test speak as GPT-Live ---------- */
const got: any[] = [];
let liveSock: WebSocket | null = null;
let fake: http.Server;
let n = 0;
const emit = (e: Record<string, unknown>) => liveSock?.send(JSON.stringify({ event_id: `fk_${++n}`, ...e }));
const until = async (f: () => unknown, ms = 6000) => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};
const sent = (type: string) => got.filter((e) => e.type === type);
/** A call for this item that has not started: the planned one, or a new one once the earlier call ended. */
async function freshCall(oid: string, purpose: string): Promise<string> {
  const open = (await world.db.query<any>("SELECT id, status FROM calls WHERE obligation_id = $1 AND status IN ('planned','blocked','ringing','in_progress') ORDER BY created_at DESC LIMIT 1", [oid])).rows[0];
  if (open && ["planned", "blocked"].includes(open.status)) return open.id;
  if (open) await world.db.query("UPDATE calls SET status = 'ended', ended_at = now() WHERE id = $1", [open.id]);
  const { newId } = await import("../src/lib/ids.js");
  const o = (await world.db.query<any>("SELECT customer_id FROM obligations WHERE id = $1", [oid])).rows[0];
  const id = newId("call");
  await world.db.query("INSERT INTO calls (id, business_id, customer_id, obligation_id, purpose, status, reason) VALUES ($1,$2,$3,$4,$5,'planned','test')", [id, world.seeded.business.id, o.customer_id, oid, purpose]);
  return id;
}

beforeAll(async () => {
  world = await freshWorld();
  fake = http.createServer((req, res) => {
    // WebRTC session create (browser voice)
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push({ type: "http", url: req.url, body: JSON.parse(body || "{}") });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ session: { id: "sess_webrtc_1" }, transport: { type: "webrtc", sdp: "v=0\r\no=fake answer" } }));
    });
  });
  const wss = new WebSocketServer({ server: fake });
  wss.on("connection", (ws, req) => {
    liveSock = ws;
    got.push({ type: "connect", url: req.url, auth: req.headers.authorization });
    ws.on("message", (d) => {
      const e = JSON.parse(d.toString());
      got.push(e);
      if (e.type === "session.start") emit({ type: "session.started", session: { id: "sess_1", model: e.session.model } });
      if (e.type === "session.close") {
        emit({ type: "session.closed", reason: "client", usage: { audio_seconds: 12 } });
        setTimeout(() => ws.close(), 20);
      }
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  Object.assign(config.ai, { openaiKey: "test-key", openaiBaseUrl: `http://127.0.0.1:${(fake.address() as AddressInfo).port}` });
  (config as any).adminKey = "adm-test";
  server = http.createServer(createApp());
  attachVoiceBridge(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (config as any).appUrl = base;
  owner = new Client(base);
  expect((await owner.post("/login", { key: world.seeded.ownerKey, next: "/today" })).location).toBe("/today");
});
afterAll(async () => {
  Object.assign(config.ai, { openaiKey: saved.key, openaiBaseUrl: saved.url });
  Object.assign(config.voice, { callMyPhoneCountries: saved.countries, twilioSid: saved.sid, twilioToken: saved.tok, twilioFrom: saved.from, webhookSecret: saved.secret });
  (config as any).adminKey = saved.admin;
  (config.paypal as any).demoVaultToken = saved.vault;
  setTelephonyFetch(null);
  await new Promise((r) => server.close(r));
  await new Promise((r) => fake.close(r));
  setPayPal(null);
  await world.db.close();
});

describe("transcript decisions: code acts on them", () => {
  it("stop, wrong person and threats end the call; a dispute stops collection; hardship and listeners steer", () => {
    expect(SIGNAL_LINE).toBe(0.8);
    expect(actionFor({ asked_to_stop_calls: true }).end?.outcome).toBe("do_not_call");
    expect(actionFor({ wrong_person: true }).end?.say).not.toMatch(/\$/);
    expect(actionFor({ threat_or_abuse: true }).end?.outcome).toBe("declined");
    const d = actionFor({ disputes_the_debt: true, distress_or_hardship: true, third_party_listening: true });
    expect(d.stopCollection).toBe(true);
    expect(d.end).toBeUndefined();
    expect(d.steer).toHaveLength(3);
  });
  it("the voice model's instructions carry no amount; code returns each line per turn", () => {
    const s = liveInstructions({ business: "Brightside", firstName: "Priya", purpose: "confirm_deposit", item: "Deposit" });
    expect(s).not.toMatch(/\$\s?\d/);
    expect(s).toContain("<|SpawnThinking|>");
    expect(s).toMatch(/Never state an amount/);
  });
});

describe("call my phone: limits", () => {
  it("is off until the operator lists countries, and only dials those", () => {
    (config.voice as any).callMyPhoneCountries = [];
    expect(() => checkDialable("+61400000000")).toThrow(/off on this deployment/);
    (config.voice as any).callMyPhoneCountries = ["AU"];
    expect(normaliseNumber("+61 (4) 0000-0000")).toBe("+61400000000");
    expect(normaliseNumber("0400 000 000")).toBeNull();
    expect(countryOf("+14155550100")).toBe("US");
    expect(() => checkDialable("+14155550100")).toThrow(/only dials numbers in AU/);
    expect(checkDialable("+61 400 000 000")).toBe("+61400000000");
  });
  it("rings through Twilio once per number an hour, with consent; TwiML streams with a one-use token", async () => {
    Object.assign(config.voice, { callMyPhoneCountries: ["AU"], twilioSid: "ACtest", twilioToken: "tok-test", twilioFrom: "+61200000000", webhookSecret: "whs" });
    const posted: string[] = [];
    setTelephonyFetch((async (_u: any, init: any) => {
      posted.push(String(init.body));
      return new Response(JSON.stringify({ sid: `CA${posted.length}`, status: "queued" }), { status: 201 });
    }) as any);
    const callId = await callFor(world.db, world.seeded.obligations.marcus_deposit);
    const noConsent = await owner.postJson(`/api/app/calls/${callId}/live/phone`, { number: "+61400000001" });
    expect(noConsent.status).toBe(400);
    const ok = await owner.postJson(`/api/app/calls/${callId}/live/phone`, { number: "+61400000001", consent: true });
    expect(ok.status).toBe(200);
    expect(posted[0]).toContain("TimeLimit=260");
    expect(decodeURIComponent(posted[0])).toContain(`/webhooks/voice/live/${callId}`);
    expect(decodeURIComponent(posted[0])).toContain("To=+61400000001");
    const row = (await world.db.query<any>("SELECT status, provider_call_id, state FROM calls WHERE id = $1", [callId])).rows[0];
    expect(row.status).toBe("ringing");
    expect(JSON.stringify(row.state)).not.toContain("61400000001"); // the visitor's number is not stored
    const tw = await owner.req("POST", `/webhooks/voice/live/${callId}?s=whs`, { form: { CallSid: "CA1" } });
    expect(tw.text).toContain("<Connect><Stream url=\"ws://127.0.0.1");
    expect(tw.text).toContain('<Parameter name="token" value="cbv_');
    expect(tw.text).toContain("<Hangup/>");
    expect((await owner.req("POST", `/webhooks/voice/live/${callId}?s=wrong`, { form: {} })).status).toBe(403);
    // The same number within the hour: refused before Twilio is asked.
    const other = await callFor(world.db, world.seeded.obligations.dev_deposit);
    const again = await owner.postJson(`/api/app/calls/${other}/live/phone`, { number: "+61400000001", consent: true });
    expect(again.status).toBe(429);
    expect(posted).toHaveLength(1);
    await owner.post(`/calls/${callId}/end`);
  });
});

describe("live voice on the phone bridge (test line = Twilio's protocol)", () => {
  it("bridges audio, runs each turn through the gate, corrects an invented amount, and acts on a stop request", async () => {
    const callId = await callFor(world.db, world.seeded.obligations.priya_deposit);
    expect((await owner.postJson(`/api/app/calls/${callId}/live/test-line`, {})).status).toBe(403); // operator key only
    const tl = await owner.req("POST", `/api/app/calls/${callId}/live/test-line`, { json: {}, headers: { "x-admin-key": "adm-test" } });
    expect(tl.status).toBe(200);
    const { token, stream_url } = tl.json;
    // The owner follows the call.
    const events: any[] = [];
    const ac = new AbortController();
    void fetch(`${base}/api/app/calls/${callId}/live/events`, { headers: { cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join("; ") }, signal: ac.signal }).then(async (r) => {
      const rd = r.body!.getReader();
      for (;;) {
        const { value, done } = await rd.read();
        if (done) break;
        for (const l of new TextDecoder().decode(value).split("\n")) if (l.startsWith("data: ")) events.push(JSON.parse(l.slice(6)));
      }
    }).catch(() => undefined);
    const twilio = new WebSocket(stream_url);
    const toPhone: any[] = [];
    twilio.on("message", (d) => toPhone.push(JSON.parse(d.toString())));
    let closed = false;
    twilio.on("close", () => (closed = true));
    await new Promise((r) => twilio.on("open", r));
    twilio.send(JSON.stringify({ event: "connected" }));
    twilio.send(JSON.stringify({ event: "start", start: { streamSid: "MZtest", callSid: "CAtest", customParameters: { call: callId, token } } }));
    await until(() => sent("session.start").length);
    const start = sent("session.start")[0];
    expect(start.session.model).toBe("gpt-live-1");
    expect(start.session.audio.format).toEqual({ type: "audio/pcmu", rate: 8000 });
    expect(start.session.delegation.type).toBe("client");
    expect(start.session.triggers[0].decisions.questions.map((q: any) => q.name)).toContain("asked_to_stop_calls");
    expect(got.find((e) => e.type === "connect")?.auth).toBe("Bearer test-key");
    // The greeting: the demo and AI disclosure, then the opening line with its verify code.
    await until(() => sent("session.commentary.append").length);
    expect(sent("session.commentary.append")[0].content).toMatch(/This is a demo call from an AI assistant\. .*verify code/i);
    // Audio both ways, unchanged.
    twilio.send(JSON.stringify({ event: "media", media: { track: "inbound", payload: "//79/A==" } }));
    await until(() => sent("session.input_audio.append").length);
    expect(sent("session.input_audio.append")[0].audio).toBe("//79/A==");
    emit({ type: "session.output_audio.delta", delta: "f39+fQ==" });
    await until(() => toPhone.some((m) => m.event === "media"));
    expect(toPhone.find((m) => m.event === "media")).toEqual({ event: "media", streamSid: "MZtest", media: { payload: "f39+fQ==" } });
    // A barge-in clears Twilio's buffer.
    emit({ type: "session.input_transcript.delta", delta: "Yes, " });
    await until(() => toPhone.some((m) => m.event === "clear"));
    // A delegated turn: the same brain and gate as a typed turn; the server's line comes back with the amount from the record.
    emit({ type: "session.input_transcript.delta", delta: "send me the link please." });
    emit({ type: "session.delegation.created", delegation: { id: "del_1" } });
    await until(() => sent("session.commentary.append").some((e) => e.delegation_id === "del_1"));
    const line = sent("session.commentary.append").find((e) => e.delegation_id === "del_1").content;
    expect(line).toContain("$60.00");
    const links = (await world.db.query<any>("SELECT amount_cents, call_id FROM pay_links WHERE call_id = $1", [callId])).rows;
    expect(links).toEqual([{ amount_cents: 6000, call_id: callId }]);
    // GPT-Live says an amount no record backs: corrected on the call and counted.
    emit({ type: "session.output_transcript.delta", delta: "Great, that will be $999 today." });
    await until(() => sent("session.instructions.append").some((e) => /\$999/.test(e.content)));
    expect(Number((await world.db.query<any>("SELECT breaches FROM calls WHERE id = $1", [callId])).rows[0].breaches)).toBeGreaterThanOrEqual(1);
    // A transcript trigger: the customer asks to stop the calls. Code ends the call and writes do-not-call.
    emit({ type: "decision.event", delegation_id: null, trigger_id: "trg_1", source_event_type: "session.input_transcript.delta", event: { type: "decision.completed", decision: { answers: [{ type: "predicate", name: "asked_to_stop_calls", probability: 0.96 }, { type: "predicate", name: "agreed_to_pay_now", probability: 0.1 }] } } });
    await until(() => sent("session.instructions.append").some((e) => /won't call you again/.test(e.content)));
    const c = (await world.db.query<any>("SELECT status, outcome, state FROM calls WHERE id = $1", [callId])).rows[0];
    expect(c.status).toBe("ended");
    expect(c.outcome).toBe("do_not_call");
    expect(c.state.signals.fired.asked_to_stop_calls.p).toBe(0.96);
    expect((await world.db.query<any>("SELECT dnc FROM customers WHERE id = $1", [world.seeded.customers.priya.id])).rows[0].dnc).toBe(true);
    // The session closes after the goodbye; the phone line closes with it, and the minutes are recorded on /ai.
    await until(() => closed, 12000);
    expect(sent("session.close")).toHaveLength(1);
    await until(async () => true);
    const ai = (await world.db.query<any>("SELECT purpose, model FROM ai_calls WHERE purpose = 'voice'")).rows;
    expect(ai[0]?.model).toBe("gpt-live-1");
    // The owner's screen saw partial lines, the decision with its probability, and the correction.
    expect(events.some((e) => e.kind === "partial" && e.who === "customer")).toBe(true);
    expect(events.some((e) => e.kind === "signal" && e.data.p.asked_to_stop_calls === 0.96)).toBe(true);
    expect(events.some((e) => e.kind === "guard")).toBe(true);
    ac.abort();
    // The stream token was used once: a second stream with it is refused.
    const replay = new WebSocket(stream_url);
    await new Promise((r) => replay.on("open", r));
    const code = await new Promise<number>((r) => {
      replay.on("close", (c) => r(c));
      replay.send(JSON.stringify({ event: "start", start: { streamSid: "MZ2", customParameters: { call: callId, token } } }));
    });
    expect(code).toBe(1008);
  }, 30000);

  it("browser voice: the app creates the WebRTC session with its key and attaches on the sideband", async () => {
    // Priya asked to stop the calls in the test above; for this one she agreed again.
    await world.db.query("UPDATE customers SET dnc = false, consent = consent - 'revoked_at' WHERE id = $1", [world.seeded.customers.priya.id]);
    const callId = await freshCall(world.seeded.obligations.priya_deposit, "confirm_deposit");
    // One call a day per customer (the policy): this call is already on the line, typed, and switches to voice.
    const { startCall } = await import("../src/services/calls.js");
    await startCall(world.db, callId, "eval", "test", { force: true });
    got.length = 0;
    const bad = await owner.postJson(`/api/app/calls/${callId}/live/webrtc`, { sdp: "nope" });
    expect(bad.status).toBe(400);
    const r = await owner.postJson(`/api/app/calls/${callId}/live/webrtc`, { sdp: "v=0\r\no=browser offer" });
    expect(r.json?.message ?? "ok").toBe("ok");
    expect(r.status).toBe(200);
    expect(r.json.answer).toContain("fake answer");
    const create = got.find((e) => e.type === "http");
    expect(create.url).toBe("/v1/live/sessions");
    expect(create.body.transport).toEqual({ type: "webrtc", sdp: "v=0\r\no=browser offer" });
    expect(create.body.session.model).toBe("gpt-live-1");
    await until(() => got.some((e) => e.type === "connect" && e.url === "/v1/live/sessions/sess_webrtc_1/attach"));
    await until(() => sent("session.commentary.append").length); // greets once attached
    // The owner steps in: said on the call as their line; amounts typed by hand are refused.
    expect((await owner.postJson(`/api/app/calls/${callId}/live/say`, { text: "It's $5 for you" })).status).toBe(400);
    expect((await owner.postJson(`/api/app/calls/${callId}/live/say`, { text: "Hi, it's the owner here." })).status).toBe(200);
    await until(() => sent("session.commentary.append").some((e) => /the owner here/.test(e.content)));
    expect((await owner.post(`/calls/${callId}/end`)).location).toMatch(/ok=/);
    await until(() => sent("session.close").length);
  }, 20000);
});

describe("a hold on the call for deposits (Orders AUTHORIZE)", () => {
  it("holds from the demo wallet, then the owner charges it after the appointment", async () => {
    (config.paypal as any).demoVaultToken = "FAKE-VAULT-TOKEN";
    const oid = world.seeded.obligations.marcus_deposit;
    const tok = world.seeded.customers.marcus.token;
    const r = await owner.post(`/c/${tok}/hold/${oid}`);
    expect(decodeURIComponent(r.location ?? "")).toMatch(/held .*not charged.*authorization AU/);
    const h = (await world.db.query<any>("SELECT * FROM holds WHERE obligation_id = $1", [oid])).rows[0];
    expect(h.status).toBe("authorized");
    expect((await world.db.query<any>("SELECT status FROM obligations WHERE id = $1", [oid])).rows[0].status).toBe("open");
    expect(world.fake.bodies.find((b) => b.method === "createVaultOrder" && (b.body as any).intent === "AUTHORIZE")).toBeTruthy();
    // No call is planned for a deposit that is held.
    const { candidates } = await import("../src/services/planner.js");
    expect((await candidates(world.db, world.seeded.business.id)).some((c) => c.obligation.id === oid)).toBe(false);
    const cap = await owner.post(`/holds/${h.id}/capture`);
    expect(decodeURIComponent(cap.location ?? "")).toMatch(/Charged \$150\.00 from the hold/);
    const o = (await world.db.query<any>("SELECT status, settled_cents, capture_id FROM obligations WHERE id = $1", [oid])).rows[0];
    expect(o).toMatchObject({ status: "paid", settled_cents: 15000 });
    expect(world.fake.captures.has(o.capture_id)).toBe(true);
    // A second charge is refused: the hold is already captured.
    expect(decodeURIComponent((await owner.post(`/holds/${h.id}/capture`)).location ?? "")).toMatch(/err=.*captured/);
  });

  it("on a call the agent texts a hold link; once approved it is authorized; a timely cancel releases it", async () => {
    const oid = world.seeded.obligations.dev_deposit;
    const { startCall, customerSays } = await import("../src/services/calls.js");
    const cid = await freshCall(oid, "confirm_deposit");
    await startCall(world.db, cid, "eval", "test", { force: true }); // Dev is outside calling hours at the test clock

    const t = await customerSays(world.db, cid, "Can you just hold it, so it's only charged if I attend?", "test");
    expect(t.tool).toBe("hold_deposit");
    expect(t.gate).toBe("allowed");
    const h = (await world.db.query<any>("SELECT * FROM holds WHERE obligation_id = $1 ORDER BY created_at DESC", [oid])).rows[0];
    expect(h.status).toBe("link_sent");
    expect(world.fake.orders.get(h.paypal_order_id)?.intent).toBe("AUTHORIZE");
    world.fake.orders.get(h.paypal_order_id)!.status = "APPROVED"; // the customer approved on PayPal's page
    const { readBack } = await import("../src/services/money.js");
    const { startRun } = await import("../src/trace.js");
    await readBack(world.db, world.seeded.business.id, await startRun({ actor: "worker", subject: "read back" }, world.db));
    const after = (await world.db.query<any>("SELECT * FROM holds WHERE id = $1", [h.id])).rows[0];
    expect(after.status).toBe("authorized");
    expect(after.authorization_id).toMatch(/^AU/);
    const rel = await owner.post(`/holds/${h.id}/void`);
    expect(decodeURIComponent(rel.location ?? "")).toMatch(/Released the \$90\.00 hold/);
    expect(world.fake.authorizations.get(after.authorization_id)?.status).toBe("VOIDED");
    expect((await world.db.query<any>("SELECT status FROM obligations WHERE id = $1", [oid])).rows[0].status).toBe("void");
    // The money page lists the holds.
    const m = await owner.req("GET", "/api/app/money", { headers: { accept: "application/json" } });
    expect(m.json.holds.map((x: any) => x.status)).toEqual(expect.arrayContaining(["captured", "voided"]));
  });

  it("a held move approved while the customer is on a live call is carried out at once and announced", async () => {
    const { carryOutApproved, liveHooks } = await import("../src/services/approvals.js");
    const { startCall } = await import("../src/services/calls.js");
    const inv = (await world.db.query<any>("SELECT id, customer_id, amount_cents FROM obligations WHERE kind = 'invoice' AND status = 'open' AND amount_cents <= 30000 ORDER BY amount_cents LIMIT 1")).rows[0];
    const cid = await freshCall(inv.id, "chase_invoice");
    await world.db.query("UPDATE customers SET dnc = false WHERE id = $1", [inv.customer_id]);
    await startCall(world.db, cid, "realtime", "test", { force: true }).catch(() => world.db.query("UPDATE calls SET status = 'in_progress' WHERE id = $1", [cid]));
    const said: string[] = [];
    const was = { ...liveHooks };
    liveHooks.isLive = (id) => id === cid;
    liveHooks.announce = (_id, text) => void said.push(text);
    try {
      const out = await carryOutApproved({ action: "charge", agentScope: `agent:${cid}`, entity: "obligation", entityId: inv.id, cents: inv.amount_cents }, "owner");
      expect(out.done).toBe(true);
      expect(out.message).toMatch(/told on the call/);
      expect(said[0]).toMatch(/Thanks for waiting\..*approved it: the PayPal link for \$/);
      expect((await world.db.query<any>("SELECT state FROM calls WHERE id = $1", [cid])).rows[0].state.link_sent).toBe(true);
    } finally {
      Object.assign(liveHooks, was);
    }
  });
});
