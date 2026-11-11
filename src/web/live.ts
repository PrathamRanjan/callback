/**
 * Live voice routes (spec B2 items 1 and 4): three ways to take a call, and the owner listening in.
 * - Call my phone: the visitor types a number and ticks consent; Twilio dials it and its audio is bridged to GPT-Live.
 * - Talk in the browser: WebRTC straight to GPT-Live; this server attaches on the sideband and runs every turn.
 * - The test line (operator key only): the same stream socket Twilio uses, for checking the deployed app by robot.
 * - The owner's screen follows the call over server-sent events and can say a line on the call.
 */
import { Router, type Request } from "express";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { GtError } from "../lib/util.js";
import { startCall } from "../services/calls.js";
import { noteRef } from "../services/wsrefs.js";
import { callById } from "../store.js";
import { issueStreamToken } from "../voice/bridge.js";
import { checkDialable, takeDictationStart, takeLiveStart } from "../voice/limits.js";
import { attachSideband, createWebrtcSession, dictationSession, instructionsForCall, LiveCall, liveBus, liveCallFor, liveReady, type LiveEvent } from "../voice/live.js";
import { recordVoiceEvent, telephonyReady, twilioCallLive, webhookAuthorised } from "../voice/telephony.js";
import { owner, who } from "./api.js";
import { json, page } from "./common.js";
import { isAdmin } from "./demo.js";

const fullUrl = (req: Request) => `${req.protocol}://${req.get("host")}${req.originalUrl}`;
const streamUrl = () => `${config.appUrl.replace(/^http/, "ws")}/voice/stream`;
const xmlEsc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

/** Starts the call record for live voice (the same consent, hours and kill-switch checks as any call). */
async function startForLive(callId: string, businessId: string, mode: "phone" | "realtime", by: string) {
  const db = await getDb();
  const c = await callById(db, callId, businessId);
  if (liveCallFor(c.id)) throw new GtError("This call already has live voice.", "bad_state");
  if (["planned", "blocked"].includes(c.status)) await startCall(db, c.id, mode, by);
  else if (c.status !== "in_progress") throw new GtError(`Call is ${c.status}.`, "bad_state");
  else if (c.mode === "realtime" || c.mode === "phone") throw new GtError("This call already used live voice. Start a new call from the plan.", "bad_state");
  return callById(db, c.id);
}

export function liveRouter(): Router {
  const r = Router();

  /** What the call page shows about live voice on this deployment. */
  r.get("/api/app/live", json(async () => ({
    voice: liveReady(), model: config.ai.models.live, phone: telephonyReady() && liveReady() && config.voice.callMyPhoneCountries.length > 0,
    phone_countries: config.voice.callMyPhoneCountries, phone_why_off: !telephonyReady() ? "No Twilio number is set on this deployment." : !config.voice.callMyPhoneCountries.length ? "The operator has not chosen which countries the demo may dial." : null,
    cap_seconds: config.voice.liveCapSeconds,
  })));

  r.post("/api/app/calls/:id/live/phone", json(async (req) => {
    const p = await owner(req);
    if (!liveReady()) throw new GtError("Live voice is not configured (OPENAI_API_KEY).", "no_model", 503);
    if (!telephonyReady()) throw new GtError("No Twilio number is set on this deployment, so Callback cannot ring a phone.", "no_phone", 503);
    if (req.body?.consent !== true && req.body?.consent !== "true" && req.body?.consent !== "on") throw new GtError("Tick the box to agree to a demo call to this number first.", "consent");
    const number = checkDialable(String(req.body?.number ?? ""));
    await takeLiveStart("phone", req.ip ?? "", number);
    const db = await getDb();
    const c = await startForLive(req.params.id, p.business_id, "phone", p.name);
    await issueStreamToken(db, c.id, "phone");
    await noteRef("call", c.id);
    const sid = await twilioCallLive(c.id, number);
    await db.query("UPDATE calls SET state = state || $2::jsonb WHERE id = $1", [c.id, JSON.stringify({ live_dialled: "the visitor's own number (not stored)" })]);
    return { ok: true, message: "Ringing your phone now. Answer it to talk to the agent; the call ends by itself after four minutes.", provider_call_id: sid };
  }));

  r.post("/api/app/calls/:id/live/test-line", json(async (req) => {
    if (!isAdmin(req)) throw new GtError("The test line needs the operator key.", "forbidden", 403);
    const p = await owner(req);
    if (!liveReady()) throw new GtError("Live voice is not configured (OPENAI_API_KEY).", "no_model", 503);
    await takeLiveStart("test-line", req.ip ?? "");
    const db = await getDb();
    const c = await startForLive(req.params.id, p.business_id, "realtime", `${p.name} (test line)`);
    const token = await issueStreamToken(db, c.id, "test-line");
    return { ok: true, stream_url: streamUrl(), call: c.id, token, format: "audio/x-mulaw;rate=8000", protocol: "Twilio Media Streams (connected, start with customParameters call and token, media, stop)" };
  }));

  /** Push-to-talk on the Ask box (spec A7): a listen-only GPT-Live session whose transcript fills the box. */
  r.post("/api/app/voice/dictate", json(async (req) => {
    const p = await who(req);
    const sdp = String(req.body?.sdp ?? "");
    if (!/^v=0/.test(sdp) || sdp.length > 20000) throw new GtError("The browser's voice offer is missing.", "bad_sdp");
    if (!liveReady()) throw new GtError("Voice input needs the live voice model, which is not configured here (OPENAI_API_KEY). Type instead.", "no_model", 503);
    await takeDictationStart(req.ip ?? "");
    const s = await createWebrtcSession("", sdp, dictationSession());
    await recordVoiceEvent("openai-live", null, "dictation.created", { session: s.sessionId, model: config.ai.models.live, by: p.role }, true);
    return { ok: true, answer: s.answer, model: config.ai.models.live, max_seconds: 60 };
  }));

  r.post("/api/app/calls/:id/live/webrtc", json(async (req) => {
    const p = await owner(req);
    if (!liveReady()) throw new GtError("Live voice is not configured (OPENAI_API_KEY).", "no_model", 503);
    const sdp = String(req.body?.sdp ?? "");
    if (!/^v=0/.test(sdp) || sdp.length > 20000) throw new GtError("The browser's voice offer is missing.", "bad_sdp");
    await takeLiveStart("browser", req.ip ?? "");
    const c = await startForLive(req.params.id, p.business_id, "realtime", `${p.name} (browser voice)`);
    const { currentWs } = await import("../db.js");
    const s = await createWebrtcSession(await instructionsForCall(c.id), sdp);
    await recordVoiceEvent("openai-live", c.id, "webrtc.created", { session: s.sessionId, model: config.ai.models.live }, true);
    const link = attachSideband(s.sessionId);
    const lc = new LiveCall({ callId: c.id, ws: currentWs(), link, role: "sideband", transport: "browser" });
    lc.sessionId = s.sessionId;
    return { ok: true, answer: s.answer, session: s.sessionId, model: config.ai.models.live };
  }));

  /** The owner's screen: the call as it happens (partial lines, decisions with probabilities, corrections). */
  r.get("/api/app/calls/:id/live/events", async (req, res, next) => {
    try {
      const p = await who(req);
      const db = await getDb();
      const c = await callById(db, req.params.id, p.business_id);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
      const send = (e: LiveEvent | Record<string, unknown>) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      send({ call: c.id, kind: "status", text: liveCallFor(c.id) ? "Live voice is on" : "No live voice on this call yet", data: { live: Boolean(liveCallFor(c.id)) }, at: new Date().toISOString() });
      const on = (e: LiveEvent) => send(e);
      liveBus.on(`call:${c.id}`, on);
      const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(ping);
        liveBus.off(`call:${c.id}`, on);
      });
    } catch (e) {
      next(e);
    }
  });

  /** The owner steps in: this line is said on the call as the business's own words. */
  r.post("/api/app/calls/:id/live/say", json(async (req) => {
    const p = await owner(req);
    const db = await getDb();
    const c = await callById(db, req.params.id, p.business_id);
    const lc = liveCallFor(c.id);
    if (!lc) throw new GtError("There is no live voice on this call.", "bad_state");
    const text = String(req.body?.text ?? "").trim().slice(0, 300);
    if (!text) throw new GtError("Type what to say first.", "empty");
    if (/\$\s?\d|\d+\s?(dollars|bucks)/i.test(text)) throw new GtError("Amounts on a call come only from the records. Approve or change the item instead of saying a number.", "amount");
    await lc.ownerSays(text, p.name);
    return { ok: true };
  }));

  /** Twilio fetches this when "call my phone" connects: stream the call's audio to /voice/stream, then hang up. */
  r.post("/webhooks/voice/live/:id", page(async (req, res) => {
    const ok = webhookAuthorised(fullUrl(req), req.body ?? {}, req.get("x-twilio-signature") ?? undefined, typeof req.query.s === "string" ? req.query.s : undefined);
    await recordVoiceEvent("twilio", req.params.id, "twiml.live", { CallSid: req.body?.CallSid ?? null, AnsweredBy: req.body?.AnsweredBy ?? null }, ok);
    const hang = `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;
    if (!ok) return res.status(403).type("text/xml").send(hang);
    const db = await getDb();
    const c = await callById(db, req.params.id).catch(() => null);
    const token = (c?.state as any)?.live_token as string | undefined;
    if (!c || !token || (c.state as any)?.live_token_used || !["ringing", "in_progress"].includes(c.status)) return res.type("text/xml").send(hang);
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xmlEsc(streamUrl())}"><Parameter name="call" value="${xmlEsc(c.id)}"/><Parameter name="token" value="${xmlEsc(token)}"/></Stream></Connect><Hangup/></Response>`);
  }));

  return r;
}
