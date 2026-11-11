// Probe for push-to-talk on Ask (spec A7): the same listen-only gpt-live-1 session the Ask box opens, over
// WebSocket instead of WebRTC so a robot can feed it a recorded question. It checks that GPT-Live accepts the
// session, transcribes the words, and stays silent (no agent speech).
// Usage: node --env-file=.env scripts/dictation-probe.mjs <wav file, G.711 mu-law 8 kHz mono>
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const wav = readFileSync(process.argv[2]);
const ws = new WebSocket("wss://api.openai.com/v1/live/sessions", { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
let heard = "";
let spoke = "";
let audio = 0;
let started = false;
let err = null;
ws.on("open", () => {
  ws.send(JSON.stringify({ type: "session.start", event_id: "start_1", session: {
    model: process.env.OPENAI_MODEL_LIVE || "gpt-live-1",
    // Keep in step with dictationSession() in src/voice/live.ts.
    instructions: "You are a dictation helper. Listen only. Never speak, never answer, never ask anything. Stay silent until the session closes.",
    audio: { format: { type: "audio/pcmu", rate: 8000 }, output: { voice: "marin" } },
  } }));
});
ws.on("message", async (d) => {
  const e = JSON.parse(d.toString());
  if (e.type === "error") err = JSON.stringify(e).slice(0, 300);
  if (e.type === "session.input_transcript.delta") heard += e.delta;
  if (e.type === "session.output_transcript.delta") spoke += e.delta;
  if (e.type === "session.output_audio.delta") audio++;
  if (e.type === "session.started" && !started) {
    started = true;
    const pcm = wav.subarray(wav.indexOf("data") + 8);
    for (let i = 0; i < pcm.length; i += 160) {
      ws.send(JSON.stringify({ type: "session.input_audio.append", audio: pcm.subarray(i, i + 160).toString("base64") }));
      await new Promise((r) => setTimeout(r, 20));
    }
    for (let i = 0; i < 300; i++) {
      ws.send(JSON.stringify({ type: "session.input_audio.append", audio: Buffer.alloc(160, 0xff).toString("base64") }));
      await new Promise((r) => setTimeout(r, 20));
    }
    ws.send(JSON.stringify({ type: "session.close" }));
  }
});
ws.on("unexpected-response", (_q, res) => { err = `HTTP ${res.statusCode}`; });
const done = () => {
  const out = { accepted: started, error: err, transcript: heard.trim(), agent_said: spoke.trim(), agent_audio_frames: audio };
  console.log(JSON.stringify(out, null, 1));
  process.exit(started && heard.trim().length > 5 && !spoke.trim() ? 0 : 1);
};
ws.on("close", done);
ws.on("error", (e) => { err = e.message; });
setTimeout(done, 40000);
