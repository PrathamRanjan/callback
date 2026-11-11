// Probe: one gpt-live-1 session over WebSocket with μ-law 8 kHz audio (Twilio's format), client delegation and a
// Decisions transcript trigger. It plays a spoken customer line (macOS `say`) and prints every event type seen.
// Usage: node --env-file=.env scripts/live-voice-probe.mjs <wav file, G.711 mu-law 8 kHz mono>
import { readFileSync } from "node:fs";
import WebSocket from "ws";
const wav = readFileSync(process.argv[2]);
const pcmu0 = wav;
const ws = new WebSocket("wss://api.openai.com/v1/live/sessions", { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
const counts = {};
let dl = 0;
const t0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
let inT = "", outT = "";
ws.on("open", () => {
  ws.send(JSON.stringify({ type: "session.start", event_id: "start_1", session: {
    model: "gpt-live-1",
    instructions: [
      "You are the phone assistant for Brightside Physio & Pilates, on a demo call with the customer Priya about her booking deposit. Speak warmly, briefly, at an unhurried pace.",
      "Backchannel policy: Use few backchannels.",
      "Interruption policy: Stop speaking when the customer interrupts. Listen to what they say.",
      "Delegation policy:",
      "Backend tools:",
      "- Studio account: the balance on record, what the studio may offer, payment links, invoices, plans, callbacks, refunds, stopping calls, proving the call is genuine.",
      "Generate <|SpawnThinking|> when:",
      "- The customer says anything beyond a greeting: a question, an answer, agreement, refusal, a request or a complaint.",
      "Do not generate <|SpawnThinking|> when:",
      "- The customer only greets you or asks you to repeat what you just said.",
      "Generate <|SpawnThinking|> before giving any answer about money, the account, identity or what happens next.",
      "Never state an amount, date, link or offer yourself, and never guess the result while waiting: say only what the result tells you.",
    ].join("\n"),
    audio: { format: { type: "audio/pcmu", rate: 8000 }, output: { voice: "marin" } },
    delegation: { type: "client", acknowledgement_delay_ms: 800 },
    triggers: [{ type: "decisions", event_type: "session.input_transcript.delta", decisions: { questions: [
      { type: "predicate", name: "asks_who_is_calling", instructions: "The customer asks who is calling or doubts the caller is really the business." },
      { type: "predicate", name: "asked_to_stop_calls", instructions: "The customer asks not to be called again." },
    ] } }],
  } }));
});
ws.on("message", (d) => {
  const e = JSON.parse(d.toString());
  counts[e.type] = (counts[e.type] ?? 0) + 1;
  if (e.type === "session.input_transcript.delta") inT += e.delta;
  if (e.type === "decision.event") { const a = e.event?.decision?.answers?.filter((x) => x.probability > 0.5); if (a?.length) log("decision", a.map((x) => `${x.name}=${x.probability}`).join(" ")); return; }
  else if (e.type === "session.output_transcript.delta") outT += e.delta;
  else if (e.type !== "session.output_audio.delta") log(e.type, JSON.stringify(e).slice(0, 400));
  if (e.type === "session.started") {
    ws.send(JSON.stringify({ type: "session.commentary.append", event_id: "greet_1", delegation_id: null, content: "Say exactly, then wait: Hi Priya, this is the AI assistant for Brightside Physio and Pilates. This is a demo call. I'm calling about the deposit for tomorrow's appointment. Is now a good time?" }));
    const play = async (buf) => {
      const pc = buf.subarray(buf.indexOf("data") + 8);
      for (let i = 0; i < pc.length; i += 160) { ws.send(JSON.stringify({ type: "session.input_audio.append", audio: pc.subarray(i, i + 160).toString("base64") })); await new Promise((r) => setTimeout(r, 20)); }
      for (let i = 0; i < 75; i++) { ws.send(JSON.stringify({ type: "session.input_audio.append", audio: Buffer.alloc(160, 0xff).toString("base64") })); await new Promise((r) => setTimeout(r, 20)); }
    };
    // Silence keeps flowing like a phone line; the customer speaks at 9 s and 22 s.
    const sil = setInterval(() => { if (!speaking) ws.send(JSON.stringify({ type: "session.input_audio.append", audio: Buffer.alloc(160, 0xff).toString("base64") })); }, 20);
    let speaking = false;
    setTimeout(async () => { speaking = true; await play(pcmu0); speaking = false; log("customer line 1 sent"); }, 9000);
    setTimeout(async () => { speaking = true; await play(readFileSync(process.argv[3])); speaking = false; log("customer line 2 sent"); }, 24000);
    setTimeout(() => clearInterval(sil), 36000);
  }
  if (e.type === "session.delegation.created") {
    setTimeout(() => ws.send(JSON.stringify({ type: "session.commentary.append", event_id: "res_1", delegation_id: e.delegation.id, content: dl++ === 0 ? "Say exactly: You can check the verification code on your account page, or call the studio on a number you already have. The deposit on record is sixty dollars." : "Say exactly: I'm sorry, there's no discount on a deposit. It's sixty dollars. Shall I text you the PayPal link?" })), 1500);
    ws.send(JSON.stringify({ type: "session.thinking.append", event_id: `quiet_${dl}`, delegation_id: e.delegation.id, content: "" }));
  }
});
ws.on("error", (e) => log("ws error", e.message));
ws.on("unexpected-response", (_req, res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => log("HTTP", res.statusCode, b.slice(0, 400))); });
setTimeout(() => { ws.send(JSON.stringify({ type: "session.close" })); }, 40000);
ws.on("close", (c, r) => { log("closed", c, String(r)); console.log("IN:", inT); console.log("OUT:", outT); console.log(counts); process.exit(0); });
setTimeout(() => process.exit(1), 52000);
