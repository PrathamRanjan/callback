/**
 * Phone path (roadmap E.4) via Twilio Programmable Voice, turn-based: Callback places the call with a TwiML URL;
 * each turn is <Say> the agent's line then <Gather input="speech"> the customer's reply, which Twilio posts back to
 * /webhooks/voice/gather/:callId. The same customerSays() the simulator uses handles the turn, so the guard, trace
 * and policy are identical on a real phone. Webhook requests are verified with Twilio's X-Twilio-Signature (HMAC-SHA1
 * over the URL + sorted form params) when TWILIO_AUTH_TOKEN is set; otherwise VOICE_WEBHOOK_SECRET in the URL.
 * Without Twilio credentials, placeCall records the call as simulated and the in-app simulator carries it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { newId } from "../lib/ids.js";
import { customerSays, speakable, startCall } from "../services/calls.js";
import { callById, customerById } from "../store.js";

let fetchImpl: typeof fetch = (i, init) => fetch(i, init);
export function setTelephonyFetch(f: typeof fetch | null) {
  fetchImpl = f ?? ((i, init) => fetch(i, init));
}

export const telephonyReady = () => Boolean(config.voice.twilioSid && config.voice.twilioToken && config.voice.twilioFrom);

const xmlEsc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
const hook = (path: string) => `${config.appUrl}${path}${config.voice.webhookSecret ? `?s=${encodeURIComponent(config.voice.webhookSecret)}` : ""}`;

export function twiml(say: string, callId: string, opts: { gather?: boolean; hangup?: boolean } = {}): string {
  const line = `<Say voice="Polly.Olivia-Neural">${xmlEsc(speakable(say))}</Say>`;
  if (opts.hangup) return `<?xml version="1.0" encoding="UTF-8"?><Response>${line}<Hangup/></Response>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="speech" action="${xmlEsc(hook(`/webhooks/voice/gather/${callId}`))}" method="POST" speechTimeout="auto" language="en-AU">${line}</Gather><Say>I didn't catch that. I'll try again another time. Goodbye.</Say><Hangup/></Response>`;
}

/** Twilio request signature: Base64(HMAC-SHA1(authToken, url + concat(sorted key+value))). */
export function verifyTwilioSignature(url: string, params: Record<string, string>, signature: string | undefined, token = config.voice.twilioToken): boolean {
  if (!token || !signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", token).update(data).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Accepts the webhook when the Twilio signature verifies or the URL secret matches; records the verdict on voice_events. */
export function webhookAuthorised(fullUrl: string, body: Record<string, string>, sig: string | undefined, secret: string | undefined): boolean {
  if (config.voice.twilioToken && verifyTwilioSignature(fullUrl, body, sig)) return true;
  if (config.voice.webhookSecret && secret === config.voice.webhookSecret) return true;
  return !config.voice.twilioToken && !config.voice.webhookSecret && config.demoMode;
}

export async function recordVoiceEvent(provider: string, callId: string | null, kind: string, payload: unknown, verified: boolean) {
  const db = await getDb();
  await db.query("INSERT INTO voice_events (id, provider, call_id, kind, payload, verified) VALUES ($1,$2,$3,$4,$5,$6)", [newId("vev"), provider, callId, kind, JSON.stringify(payload), verified]);
}

/** Places the call. With Twilio: POST /Calls with the TwiML URL. Without: marks it simulated and the UI runs it. */
export async function placeCall(callId: string, by: string, mode: "phone" | "simulator" | null = null): Promise<{ mode: "phone" | "simulator"; providerCallId: string | null; opening: string }> {
  const db = await getDb();
  const call = await callById(db, callId);
  const customer = await customerById(db, call.customer_id);
  if (!telephonyReady() || mode === "simulator") {
    const r = await startCall(db, callId, "simulator", by);
    return { mode: "simulator", providerCallId: null, opening: r.opening };
  }
  const r = await startCall(db, callId, "phone", by);
  const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${config.voice.twilioSid}/Calls.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${config.voice.twilioSid}:${config.voice.twilioToken}`).toString("base64"), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: customer.phone, From: config.voice.twilioFrom, Url: hook(`/webhooks/voice/twiml/${callId}`), StatusCallback: hook(`/webhooks/voice/status/${callId}`), StatusCallbackEvent: "initiated ringing answered completed", MachineDetection: "Enable" }).toString(),
  });
  const data = (await res.json()) as any;
  if (!res.ok) {
    await db.query("UPDATE calls SET status = 'blocked', reason = $2 WHERE id = $1", [callId, `Twilio: ${data.message ?? res.status}`]);
    throw new Error(`Twilio: ${data.message ?? res.status}`);
  }
  await db.query("UPDATE calls SET provider_call_id = $2, status = 'ringing' WHERE id = $1", [callId, data.sid]);
  await recordVoiceEvent("twilio", callId, "placed", { sid: data.sid, status: data.status }, true);
  return { mode: "phone", providerCallId: data.sid ?? null, opening: r.opening };
}

/** First TwiML: the opening line already recorded by startCall. */
export async function openingTwiml(callId: string): Promise<string> {
  const db = await getDb();
  const call = await callById(db, callId);
  await db.query("UPDATE calls SET status = 'in_progress' WHERE id = $1 AND status = 'ringing'", [callId]);
  const opening = call.transcript.find((t) => t.who === "agent")?.text ?? "Hello, this is the assistant calling about your account.";
  return twiml(opening, callId);
}

/** A gathered utterance -> one agent turn -> TwiML for the reply. */
export async function gatherTwiml(callId: string, speech: string, confidence: number | null): Promise<string> {
  const db = await getDb();
  await recordVoiceEvent("twilio", callId, "speech", { speech, confidence }, true);
  const call = await callById(db, callId);
  if (call.status !== "in_progress") return twiml("Thanks, that's everything. Goodbye.", callId, { hangup: true });
  const r = await customerSays(db, callId, speech || "(silence)", "phone");
  return twiml(r.say, callId, { hangup: r.ended });
}

export async function statusEvent(callId: string, body: Record<string, string>, verified: boolean) {
  const db = await getDb();
  await recordVoiceEvent("twilio", callId, `status:${body.CallStatus ?? "?"}`, body, verified);
  if (!verified) return;
  const st = body.CallStatus;
  if (["no-answer", "busy", "failed", "canceled"].includes(st)) {
    const { endCall } = await import("../services/calls.js");
    await endCall(db, callId, "no_answer", "twilio");
  } else if (st === "completed") {
    const c = await callById(db, callId);
    if (c.status === "in_progress") {
      const { endCall } = await import("../services/calls.js");
      await endCall(db, callId, null, "twilio");
    }
  }
  if (body.AnsweredBy && /machine/i.test(body.AnsweredBy)) {
    const { endCall } = await import("../services/calls.js");
    await endCall(db, callId, "no_answer", "twilio");
  }
}
