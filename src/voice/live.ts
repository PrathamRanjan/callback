/**
 * Live voice on GPT-Live (`gpt-live-1`, spec B2 item 1 and A10). One controller per call, the same for a phone call
 * (Twilio Media Streams bridged to a WebSocket session) and for the browser (WebRTC, with this server on the sideband).
 *
 * GPT-Live carries the conversation. It never decides anything about money: the session uses client delegation, so
 * whenever the customer says something that needs the account, GPT-Live hands the turn to this server, which runs the
 * same turn brain, gate and PayPal calls as a typed turn (customerSays) and returns the exact line to say.
 * Its own transcript triggers ask the nine call questions as the customer speaks (src/voice/signals.ts); code acts on
 * the answers at once. Every line it speaks is checked for dollar amounts that no record backs, and corrected.
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { config } from "../config.js";
import { getDb, inWorkspace } from "../db.js";
import { audit } from "../ai/provider.js";
import { customerSays, endCall, recordLiveSpeech, speakable } from "../services/calls.js";
import { callById, customerById, obligationById, bizById } from "../store.js";
import { actionFor, recordSignals, SIGNAL_QUESTIONS } from "./signals.js";
import { recordVoiceEvent } from "./telephony.js";
import { liveHooks } from "../services/approvals.js";

/** Live voice needs the OpenAI key. (The deployed app refuses to boot without it and without AI_PROVIDER=openai.) */
export const liveReady = () => Boolean(config.ai.openaiKey) && config.ai.provider !== "none";
const LIVE_URL = () => `${config.ai.openaiBaseUrl.replace(/^http/, "ws")}/v1/live/sessions`;

/** What the owner's screen hears about a live call: partial and final lines, decisions, status. */
export interface LiveEvent { call: string; kind: "partial" | "line" | "signal" | "status" | "guard"; who?: "customer" | "agent" | "owner"; text?: string; data?: unknown; at: string }
export const liveBus = new EventEmitter();
liveBus.setMaxListeners(500);
const publish = (e: Omit<LiveEvent, "at">) => liveBus.emit(`call:${e.call}`, { ...e, at: new Date().toISOString() });

const live = new Map<string, LiveCall>();
export const liveCallFor = (callId: string) => live.get(callId) ?? null;
export const liveCalls = () => [...live.keys()];
liveHooks.isLive = (id) => live.has(id);
liveHooks.announce = (id, text) => live.get(id)?.announce(text);

/** The voice model's instructions. No amounts or offers are in them: those come back from the server per turn. */
export function liveInstructions(ctx: { business: string; firstName: string; purpose: string; item: string }): string {
  return [
    `You are the phone assistant for ${ctx.business}, a small studio, speaking with the customer ${ctx.firstName} about "${ctx.item}" (${ctx.purpose.replace(/_/g, " ")}). This is a demo call and you are an AI; say so if asked. Speak warmly, briefly, at an unhurried pace.`,
    "Backchannel policy: Use few backchannels.",
    "Interruption policy: Stop speaking when the customer interrupts. Listen to what they say.",
    "Delegation policy:",
    "Backend tools:",
    "- Studio account: the balance on record, what the studio may offer, payment links, invoices, payment plans, holds, callbacks, refunds and credits, stopping calls, proving the call is genuine.",
    "Generate <|SpawnThinking|> when:",
    "- The customer says anything beyond a greeting: a question, an answer, agreement, refusal, a request or a complaint.",
    "- A correction changes something already asked for.",
    "Do not generate <|SpawnThinking|> when:",
    "- The customer only greets you, or asks you to repeat what you just said.",
    "Generate <|SpawnThinking|> before giving any answer about money, the account, identity or what happens next.",
    "Never state an amount, date, link, discount or plan yourself, and never guess a result while waiting. When the result arrives, say it in your own voice without changing any number, and then wait.",
    "Never ask for card numbers, codes or passwords.",
  ].join("\n");
}

/** The session the server opens (phone, test line) or creates for the browser. */
export function liveSession(instructions: string, format: { type: "audio/pcmu" | "audio/pcm"; rate: number } | null) {
  return {
    model: config.ai.models.live,
    instructions,
    audio: { ...(format ? { format } : {}), output: { voice: config.ai.models.liveVoice } },
    delegation: { type: "client", acknowledgement_delay_ms: 800 },
    // Native Decisions on the transcript: the nine call questions, asked as the customer's words arrive.
    triggers: [{ type: "decisions", event_type: "session.input_transcript.delta", decisions: { questions: SIGNAL_QUESTIONS } }],
  };
}

/** Builds the voice model's instructions for a call from its records. */
export async function instructionsForCall(callId: string): Promise<string> {
  const db = await getDb();
  const call = await callById(db, callId);
  const cu = await customerById(db, call.customer_id);
  const biz = await bizById(db, call.business_id);
  const o = call.obligation_id ? await obligationById(db, call.obligation_id) : null;
  return liveInstructions({ business: biz.name, firstName: cu.name.split(" ")[0], purpose: call.purpose, item: o?.title ?? "their account" });
}

const MONEY = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)|\b(\d[\d,]*(?:\.\d{1,2})?)\s?(?:dollars|bucks)\b/gi;
const amountsIn = (s: string) => [...s.matchAll(MONEY)].map((m) => Number((m[1] ?? m[2]).replace(/,/g, "")).toFixed(2));
const sayMs = (s: string) => Math.min(20_000, 1500 + (s.split(/\s+/).length / 2.6) * 1000);

export interface LiveOpts {
  callId: string;
  ws: string | null;
  /** "primary": this server holds the session's own connection (phone, test line). "sideband": the browser holds it. */
  link: WebSocket;
  role: "primary" | "sideband";
  transport: "phone" | "browser" | "test-line";
  onAudio?: (b64: string) => void;
  onBargeIn?: () => void;
  onEnd?: () => void;
}

export class LiveCall {
  readonly callId: string;
  readonly transport: LiveOpts["transport"];
  sessionId: string | null = null;
  private ws: string | null;
  private link: WebSocket;
  private o: LiveOpts;
  private heard = "";
  private saying = "";
  private allowed = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();
  private seen = new Set<string>();
  private closing = false;
  private ended = false;
  private greeted = false;
  private startedAt = Date.now();
  private cap: NodeJS.Timeout;
  private n = 0;
  private lastAudioAt = 0;
  private started = false;
  private failedToStart: string | null = null;

  constructor(o: LiveOpts) {
    this.o = o;
    this.callId = o.callId;
    this.ws = o.ws;
    this.link = o.link;
    this.transport = o.transport;
    live.set(o.callId, this);
    o.link.on("message", (d) => void this.onEvent(JSON.parse(d.toString())).catch((e) => console.error(`[live ${this.callId}]`, (e as Error).message)));
    o.link.on("close", () => void this.finish("the voice session closed"));
    o.link.on("error", (e) => console.error(`[live ${this.callId}] socket`, e.message));
    this.cap = setTimeout(() => void this.speakThenClose("We've reached the time limit for this demo call, so I'll stop here. Thank you. Goodbye."), config.voice.liveCapSeconds * 1000);
    publish({ call: this.callId, kind: "status", text: `Live voice connected (${o.transport}, ${config.ai.models.live})` });
    // An attached sideband belongs to a session that has already started (the browser holds it): greet once attached.
    if (o.role === "sideband") {
      this.started = true;
      o.link.on("open", () => setTimeout(() => void this.greet().catch((e) => console.error(`[live ${this.callId}] greet`, (e as Error).message)), 700));
    }
  }

  /** Caller audio from the phone line (base64 μ-law), passed to the session unchanged. */
  sendAudio(b64: string) {
    if (this.started && b64) this.send({ type: "session.input_audio.append", audio: b64 });
  }

  private inWs<T>(fn: () => Promise<T>): Promise<T> {
    return inWorkspace(this.ws, fn);
  }
  private send(e: Record<string, unknown>) {
    if (this.link.readyState === WebSocket.OPEN) this.link.send(JSON.stringify({ event_id: `cb_${this.callId}_${++this.n}`, ...e }));
  }
  /** Tells GPT-Live to say a line from code. It may change the wording a little; the numbers are checked as it speaks. */
  private sayLine(text: string, delegationId: string | null) {
    const line = speakable(text);
    for (const a of amountsIn(line)) this.allowed.add(a);
    this.send({ type: "session.commentary.append", delegation_id: delegationId, content: `Say this to the customer, keeping every number exactly, then wait: ${line}` });
  }

  /** The greeting: the call's opening line (with its verify code), with the AI and demo disclosure first. */
  async greet() {
    if (this.greeted) return;
    this.greeted = true;
    const call = await this.inWs(async () => callById(await getDb(), this.callId));
    const opening = call.transcript.find((t) => t.who === "agent")?.text ?? "";
    for (const t of call.transcript) for (const a of amountsIn(t.text)) this.allowed.add(a);
    this.sayLine(`This is a demo call from an AI assistant. ${opening}`, null);
  }

  private async onEvent(e: any) {
    if (e.event_id) {
      if (this.seen.has(e.event_id)) return; // the sideband replays the last 3 seconds on attach
      this.seen.add(e.event_id);
    }
    switch (e.type) {
      case "session.started":
        this.started = true;
        this.sessionId = e.session?.id ?? this.sessionId;
        await this.inWs(() => recordVoiceEvent("openai-live", this.callId, "session.started", { session: this.sessionId, model: e.session?.model, transport: this.transport }, true));
        await this.greet();
        break;
      case "session.output_audio.delta":
        this.lastAudioAt = Date.now();
        if (this.o.onAudio) this.o.onAudio(e.delta);
        break;
      case "session.input_transcript.delta":
        this.heard += e.delta;
        publish({ call: this.callId, kind: "partial", who: "customer", text: this.heard.trim() });
        // The customer talks over the agent: stop the agent's audio on the phone line at once.
        if (Date.now() - this.lastAudioAt < 400) this.o.onBargeIn?.();
        break;
      case "session.output_transcript.delta":
        this.saying += e.delta;
        publish({ call: this.callId, kind: "partial", who: "agent", text: this.saying.trim() });
        this.guardSpeech();
        break;
      case "session.delegation.created":
        this.chain = this.chain.then(() => this.turn(e.delegation?.id ?? null));
        break;
      case "decision.event":
        if (!e.delegation_id && e.event?.type === "decision.completed") this.chain = this.chain.then(() => this.onSignals(e.event.decision?.answers ?? []));
        break;
      case "session.closed":
        await this.inWs(() => recordVoiceEvent("openai-live", this.callId, "session.closed", { reason: e.reason, usage: e.usage ?? e.session?.usage ?? null }, true));
        await this.finish(`the voice session closed (${e.reason ?? "closed"})`);
        break;
      case "error":
        console.error(`[live ${this.callId}] error event`, JSON.stringify(e).slice(0, 300));
        await this.inWs(() => recordVoiceEvent("openai-live", this.callId, "error", e, true));
        // The session never started: nothing was said, so the call ends honestly as an AI failure.
        if (!this.started) this.failedToStart = String(e.error?.message ?? "the voice session was refused").slice(0, 200);
        break;
    }
  }

  /** A dollar amount the voice model said that no line from code contained: correct it on the call, count a breach. */
  private guardSpeech() {
    const bad = amountsIn(this.saying).filter((a) => !this.allowed.has(a));
    if (!bad.length) return;
    for (const a of bad) this.allowed.add(a); // correct each one once
    this.send({ type: "session.instructions.append", delegation_id: null, content: `Stop. You said $${bad.join(", $")}, which is not on the account. Say: "Sorry, let me correct that." Then say only the amounts the results gave you.` });
    publish({ call: this.callId, kind: "guard", text: `Corrected an amount the voice model said: $${bad.join(", $")}` });
    void this.inWs(async () => {
      const db = await getDb();
      await db.query("UPDATE calls SET breaches = breaches + 1 WHERE id = $1", [this.callId]);
      await recordVoiceEvent("openai-live", this.callId, "guard.amount", { said: bad, line: this.saying.slice(-200) }, true);
    });
  }

  /** One delegated turn: the customer's words since the last turn go through the same brain and gate as a typed turn. */
  private async turn(delegationId: string | null) {
    if (this.ended) return;
    const said = this.heard.trim();
    this.heard = "";
    if (this.saying.trim()) publish({ call: this.callId, kind: "line", who: "agent", text: this.saying.trim() });
    this.saying = "";
    if (!said) {
      this.send({ type: "session.thinking.append", delegation_id: delegationId, content: "Nothing new to act on; carry on the conversation." });
      return;
    }
    publish({ call: this.callId, kind: "line", who: "customer", text: said });
    try {
      const r = await this.inWs(async () => customerSays(await getDb(), this.callId, said, `live voice (${this.transport})`, { signals: "native" }));
      this.sayLine(r.say, delegationId);
      publish({ call: this.callId, kind: "line", who: "agent", text: r.say, data: { tool: r.tool, gate: r.gate, result: r.tool_result } });
      if (r.ended) this.closeAfter(sayMs(r.say) + 2500);
    } catch (e) {
      const msg = (e as Error).message;
      if (/Call is ended/.test(msg)) return this.closeAfter(500);
      this.sayLine("Sorry, something went wrong on my side. The studio will call you back. Goodbye.", delegationId);
      publish({ call: this.callId, kind: "status", text: `Turn failed: ${msg.slice(0, 160)}` });
      await this.inWs(async () => endCall(await getDb(), this.callId, "ai_failed", "live voice"));
      this.closeAfter(6000);
    }
  }

  /** GPT-Live's transcript triggers answered the nine questions: record them, and let code act on any that crossed the line. */
  private async onSignals(answers: { type: string; name: string; probability?: number }[]) {
    if (this.ended) return;
    const p: Record<string, number> = {};
    for (const a of answers) if (a.type === "predicate" && typeof a.probability === "number") p[a.name] = a.probability;
    if (!Object.keys(p).length) return;
    const out = await this.inWs(async () => recordSignals(await getDb(), this.callId, p, `GPT-Live transcript trigger (${config.ai.models.decisions})`));
    publish({ call: this.callId, kind: "signal", data: { p: out.state.p, fired: Object.keys(out.state.fired) } });
    if (!out.newly.length) return;
    const act = actionFor(out.state.fired);
    if (act.end) {
      const end = act.end;
      await this.inWs(async () => {
        const db = await getDb();
        const call = await callById(db, this.callId);
        if (call.status !== "in_progress") return;
        if (end.outcome === "do_not_call") await db.query("UPDATE customers SET dnc = true, consent = jsonb_set(coalesce(consent, '{}'::jsonb), '{revoked_at}', to_jsonb(now()::text)) WHERE id = $1", [call.customer_id]);
        await recordLiveSpeech(db, this.callId, "customer", this.heard.trim() || "(live voice)");
        await recordLiveSpeech(db, this.callId, "agent", end.say);
        await endCall(db, this.callId, end.outcome, "transcript decision");
      });
      this.heard = "";
      this.ended = true;
      this.send({ type: "session.instructions.append", delegation_id: null, content: `Stop what you are saying. Say exactly: "${end.say}" Then say nothing more.` });
      publish({ call: this.callId, kind: "line", who: "agent", text: end.say, data: { by: "code", outcome: end.outcome } });
      this.closeAfter(sayMs(end.say) + 2500);
    } else if (act.steer.length) {
      this.send({ type: "session.thinking.append", delegation_id: null, content: act.steer.join(" ") });
    }
  }

  /** The owner steps in: a line typed on the call page is said on the call, and recorded as the owner's. */
  async ownerSays(text: string, by: string) {
    await this.inWs(async () => recordLiveSpeech(await getDb(), this.callId, "agent", `${text}`));
    this.sayLine(text, null);
    publish({ call: this.callId, kind: "line", who: "owner", text, data: { by } });
  }
  /** Something finished off the call (an approval): tell the customer while they are still on the line. */
  announce(text: string) {
    if (this.ended) return;
    this.sayLine(text, null);
    publish({ call: this.callId, kind: "line", who: "agent", text, data: { by: "code" } });
    // Recorded in turn order, so a turn writing the transcript at the same moment cannot lose it.
    this.chain = this.chain.then(() => this.inWs(async () => recordLiveSpeech(await getDb(), this.callId, "agent", text))).catch(() => undefined);
  }

  private async speakThenClose(text: string) {
    if (this.closing) return;
    this.sayLine(text, null);
    this.closeAfter(sayMs(text) + 2000);
  }
  private closeAfter(ms: number) {
    if (this.closing) return;
    this.closing = true;
    setTimeout(() => this.close(), ms);
  }
  close() {
    this.closing = true;
    if (this.link.readyState === WebSocket.OPEN) {
      this.send({ type: "session.close" });
      setTimeout(() => this.link.readyState === WebSocket.OPEN && this.link.close(), 8000);
    } else void this.finish("closed");
  }

  /** Ends the call record (if still open), records the voice minutes on /ai, and lets the transport hang up. */
  private async finish(why: string) {
    if (!live.has(this.callId) || live.get(this.callId) !== this) return;
    live.delete(this.callId);
    clearTimeout(this.cap);
    const secs = Math.round((Date.now() - this.startedAt) / 1000);
    await this.inWs(async () => {
      const db = await getDb();
      const call = await callById(db, this.callId);
      if (call.status === "in_progress") await endCall(db, this.callId, this.failedToStart ? "ai_failed" : null, this.failedToStart ? `live voice did not start: ${this.failedToStart}` : "live voice");
      // $0.05 a minute (OpenAI's GPT-Live price, per the launch notes; not read from a pricing page here).
      await audit({ purpose: "voice", model: config.ai.models.live, via: this.transport, inputHash: this.sessionId ?? "", outputHash: "", tokensIn: 0, tokensOut: 0, costUsd: Number(((secs / 60) * 0.05).toFixed(4)), latencyMs: secs * 1000, ok: true, error: null, output: { session: this.sessionId, seconds: secs, why }, runId: call.run_id });
    }).catch((e) => console.error(`[live ${this.callId}] finish`, (e as Error).message));
    publish({ call: this.callId, kind: "status", text: `Live voice ended (${why}, ${secs} s)` });
    this.o.onEnd?.();
  }
}

/** Opens a session this server holds (phone bridge, test line): μ-law 8 kHz, Twilio's own format, passed through as is. */
export function openPrimary(instructions: string, format: { type: "audio/pcmu" | "audio/pcm"; rate: number }): WebSocket {
  const link = new WebSocket(LIVE_URL(), { headers: { Authorization: `Bearer ${config.ai.openaiKey}` } });
  link.on("open", () => link.send(JSON.stringify({ type: "session.start", event_id: "cb_start", session: liveSession(instructions, format) })));
  link.on("unexpected-response", (_req, res) => {
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => console.error(`[live] session refused: HTTP ${res.statusCode} ${body.slice(0, 200)}`));
  });
  return link;
}

/**
 * Push-to-talk dictation for a text box (spec A7, "voice both ways"): a GPT-Live session that only listens. Its
 * input transcript fills the box; the browser never plays its audio, nothing is delegated, and no tool exists, so
 * what the person said is only typed for them to read, change and send.
 */
export function dictationSession() {
  return {
    model: config.ai.models.live,
    instructions: "You are a dictation helper. Listen only. Never speak, never answer, never ask anything. Stay silent until the session closes.",
    audio: { output: { voice: config.ai.models.liveVoice } },
  };
}

/** Browser voice: creates a WebRTC session from the browser's offer, then attaches this server on the sideband. */
export async function createWebrtcSession(instructions: string, sdp: string, session: Record<string, unknown> = liveSession(instructions, null)): Promise<{ sessionId: string; answer: string }> {
  const res = await fetch(`${config.ai.openaiBaseUrl}/v1/live/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.ai.openaiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ session, transport: { type: "webrtc", sdp } }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GPT-Live refused the session: ${res.status} ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  return { sessionId: String(data.session?.id ?? ""), answer: String(data.transport?.sdp ?? "") };
}
export function attachSideband(sessionId: string): WebSocket {
  return new WebSocket(`${LIVE_URL()}/${encodeURIComponent(sessionId)}/attach`, { headers: { Authorization: `Bearer ${config.ai.openaiKey}` } });
}
