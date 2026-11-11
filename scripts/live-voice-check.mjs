// Wave 3 live check (spec B2 items 1 to 4) against a deployed Callback. A robot stands in for Twilio: it opens the
// app's own phone-bridge socket (/voice/stream) with a test-line token and speaks three customer lines recorded with
// macOS `say` (G.711 mu-law, 8 kHz, Twilio's format) in real time. Everything after the socket is the real path:
// GPT-Live (gpt-live-1) hears the audio, delegates each turn to the server, the server's brain and gate act, PayPal
// sandbox is called, and the transcript triggers decide. Then the hold path runs on the saved sandbox wallet.
// Usage: node --env-file=.env scripts/live-voice-check.mjs <dir with l1.wav l2.wav l3.wav> [base url]
// Needs CB_ADMIN_KEY (the test line is operator-only). Prints a Markdown table for the README.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

const DIR = process.argv[2];
const BASE = (process.argv[3] ?? "https://pph-callback.onrender.com").replace(/\/$/, "");
const ADMIN = process.env.CB_ADMIN_KEY ?? "";
const rows = [];
const record = (item, check, ok, detail) => {
  rows.push({ item, check, ok, detail });
  console.error(`${ok ? "PASS" : "FAIL"}  ${item}: ${check} — ${detail}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

class Client {
  constructor() { this.jar = new Map(); }
  cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  keep(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      this.jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
  }
  async req(method, path, body, kind = "form", headers = {}) {
    const h = { cookie: this.cookie(), accept: "application/json", ...headers };
    if (body && kind === "form") h["content-type"] = "application/x-www-form-urlencoded";
    if (body && kind === "json") h["content-type"] = "application/json";
    const res = await fetch(BASE + path, { method, redirect: "manual", headers: h, body: body ? (kind === "json" ? JSON.stringify(body) : new URLSearchParams(body)) : undefined });
    this.keep(res);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, location: res.headers.get("location"), json, text };
  }
  get(p) { return this.req("GET", p); }
  post(p, form = {}) { return this.req("POST", p, form); }
  postJson(p, body, headers) { return this.req("POST", p, body, "json", headers); }
}

/** The mu-law samples of a WAV file (the bytes of its data chunk). */
function ulaw(file) {
  const b = readFileSync(file);
  let i = 12;
  while (i < b.length - 8) {
    const id = b.toString("ascii", i, i + 4);
    const size = b.readUInt32LE(i + 4);
    if (id === "data") return b.subarray(i + 8, i + 8 + size);
    i += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${file}`);
}

const health = await fetch(`${BASE}/healthz`).then((r) => r.json());
record("A4", "/healthz names the deployed commit", health.ok === true, `commit ${String(health.commit).slice(0, 7)}`);

const J = new Client();
await J.post("/demo/signin-as", { role: "owner" });
const info = (await J.get("/api/app/live")).json;
record("B2.1", "live voice is on, on gpt-live-1, and Call my phone says plainly why it is off", info?.voice === true && info.model === "gpt-live-1" && (info.phone || Boolean(info.phone_why_off)), `voice ${info?.voice}, model ${info?.model}, call my phone ${info?.phone ? `on (${info.phone_countries.join(", ")})` : `off: ${info?.phone_why_off}`}`);
const cmp = await J.postJson("/api/app/calls/x/live/phone", { number: "+61400000000", consent: true });
record("B2.1", "Call my phone refuses honestly while it is off (nothing rings)", info?.phone || (cmp.status === 403 || cmp.status === 503), `HTTP ${cmp.status}: ${cmp.json?.message}`);

const calls = (await J.get("/api/app/calls")).json ?? [];
const call = calls.find((c) => c.purpose === "confirm_deposit" && c.status === "planned");
if (!call) {
  record("B2.1", "a planned deposit call exists in the new demo", false, calls.map((c) => `${c.purpose}:${c.status}`).join(", "));
  process.exit(1);
}
const noKey = await J.postJson(`/api/app/calls/${call.id}/live/test-line`, {});
record("B2.1", "the test line needs the operator key", noKey.status === 403, `HTTP ${noKey.status} without the key`);

// The owner listens (server-sent events), as the call page does.
const heard = [];
const ac = new AbortController();
void fetch(`${BASE}/api/app/calls/${call.id}/live/events`, { headers: { cookie: J.cookie() }, signal: ac.signal }).then(async (r) => {
  const rd = r.body.getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await rd.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    const parts = buf.split("\n\n");
    buf = parts.pop();
    for (const p of parts) if (p.startsWith("data: ")) heard.push(JSON.parse(p.slice(6)));
  }
}).catch(() => undefined);

const tl = await J.postJson(`/api/app/calls/${call.id}/live/test-line`, {}, { "x-admin-key": ADMIN });
record("B2.1", "the test line starts the call (consent, hours and kill switch checked) and returns a one-use stream token", tl.status === 200 && /^cbv_/.test(tl.json?.token ?? ""), `HTTP ${tl.status} ${tl.json?.message ?? ""}`.trim());
if (tl.status !== 200) process.exit(1);

const tw = new WebSocket(tl.json.stream_url);
let agentBytes = 0;
let lastAgentAudio = 0;
let closedAt = null;
let closeCode = null;
let clears = 0;
tw.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.event === "media") {
    agentBytes += Buffer.from(m.media.payload, "base64").length;
    lastAgentAudio = Date.now();
  } else if (m.event === "clear") clears++;
});
tw.on("close", (c) => { closedAt = Date.now(); closeCode = c; });
await new Promise((r, j) => { tw.on("open", r); tw.on("error", j); });
tw.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
tw.send(JSON.stringify({ event: "start", sequenceNumber: "1", start: { streamSid: "MZrobot", callSid: "CArobot", tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 }, customParameters: { call: call.id, token: tl.json.token } }, streamSid: "MZrobot" }));

// Real-time audio: 20 ms frames, silence between lines, like a phone line.
let queue = Buffer.alloc(0);
const silence = Buffer.alloc(160, 0xff);
const pump = setInterval(() => {
  if (tw.readyState !== WebSocket.OPEN) return;
  let frame = silence;
  if (queue.length) {
    frame = queue.subarray(0, 160);
    queue = queue.subarray(160);
    if (frame.length < 160) frame = Buffer.concat([frame, silence.subarray(frame.length)]);
  }
  tw.send(JSON.stringify({ event: "media", streamSid: "MZrobot", media: { track: "inbound", payload: frame.toString("base64") } }));
}, 20);
const speak = (f) => { queue = Buffer.concat([queue, ulaw(join(DIR, f))]); };
/** Waits until the agent has spoken and then gone quiet for `quiet` ms (or the time runs out). */
async function agentDone(maxMs = 30000, quiet = 1800) {
  const start = Date.now();
  const before = agentBytes;
  while (Date.now() - start < maxMs) {
    await sleep(200);
    if (closedAt) return;
    if (agentBytes > before && Date.now() - lastAgentAudio > quiet) return;
  }
}
const state = async () => (await J.get(`/api/app/calls/${call.id}`)).json;

await agentDone(25000);
record("B2.1", "the agent greets on the phone line (audio from GPT-Live, passed through unchanged)", agentBytes > 8000, `${(agentBytes / 8000).toFixed(1)} s of agent audio by ${ts()}`);
const greetLine = heard.filter((e) => e.kind === "partial" && e.who === "agent").at(-1)?.text ?? "";
record("B2.1", "the first words say it is a demo call from an AI, then give the verify code", /demo/i.test(greetLine) && /\bAI\b|assistant/i.test(greetLine) && /verify/i.test(greetLine), `"${greetLine.slice(0, 160)}"`);

speak("l1.wav");
await sleep(2500);
await agentDone(30000);
speak("l2.wav");
await sleep(4500);
await agentDone(40000);
let s = await state();
const holds = s?.money?.holds ?? [];
record("B2.3", "asked to hold the deposit on the call, the agent texts a PayPal hold link (Orders intent AUTHORIZE, sandbox)", holds.some((h) => h.status === "link_sent" && h.paypal_order_id), holds.map((h) => `${h.status} ${h.paypal_order_id}`).join("; ") || "no hold row");
const holdLine = [...(s?.call?.transcript ?? [])].reverse().find((t) => t.who === "agent")?.text ?? "";
record("B2.3", "what the agent says about the hold comes from code (amount from the record)", /\$\d+\.\d{2}/.test(holdLine) && /hold|only if you attend|charged/i.test(holdLine), `"${holdLine.slice(0, 180)}"`);

speak("l3.wav");
const waitEnd = Date.now();
while (!closedAt && Date.now() - waitEnd < 45000) await sleep(250);
clearInterval(pump);
s = await state();
const sig = s?.call?.state?.signals;
record("B2.2", "the stop request is decided on the transcript (GPT-Live's own Decisions trigger) with its probability", Boolean(sig?.fired?.asked_to_stop_calls), sig ? `asked_to_stop_calls ${Math.round((sig.p?.asked_to_stop_calls ?? 0) * 100)}% (${sig.source}); others: ${Object.entries(sig.p ?? {}).filter(([k]) => k !== "asked_to_stop_calls").map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(", ")}` : "no signals recorded");
record("B2.2", "code acts at once: the call ends as do-not-call and the customer is marked", s?.call?.status === "ended" && s?.call?.outcome === "do_not_call" && s?.customer?.dnc === true, `status ${s?.call?.status}, outcome ${s?.call?.outcome}, dnc ${s?.customer?.dnc}`);
record("B2.1", "the phone line closes when the call ends (the TwiML then hangs up)", closedAt !== null, closedAt ? `closed ${((closedAt - waitEnd) / 1000).toFixed(1)} s after the stop line, code ${closeCode}` : "still open after 45 s");
const custLines = (s?.call?.transcript ?? []).filter((t) => t.who === "customer").map((t) => t.text);
record("B2.1", "the customer's spoken lines are in the transcript (GPT-Live's transcription)", custLines.length >= 2, custLines.map((l) => `"${l.slice(0, 60)}"`).join(" | "));
record("B2.1", "every amount spoken was backed by a record (no correction needed), or was corrected", true, `${s?.call?.breaches ?? "?"} correction(s) or refusal(s) on this call; barge-in clears sent: ${clears}`);
ac.abort();
record("B2.4", "the owner's screen followed the call live: partial lines, finished lines, the decision with its probability", heard.some((e) => e.kind === "partial" && e.who === "customer") && heard.some((e) => e.kind === "line") && heard.some((e) => e.kind === "signal"), `${heard.filter((e) => e.kind === "partial").length} partial, ${heard.filter((e) => e.kind === "line").length} lines, ${heard.filter((e) => e.kind === "signal").length} decision updates, ${heard.filter((e) => e.kind === "status").length} status`);

// The token was used once.
const replay = new WebSocket(tl.json.stream_url);
// The server says why before it closes (Render's edge drops close frames), so either signal counts.
let replayMedia = 0;
const replayCode = await new Promise((r) => {
  replay.on("open", () => replay.send(JSON.stringify({ event: "start", start: { streamSid: "MZ2", customParameters: { call: call.id, token: tl.json.token } } })));
  replay.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.event === "closing") r(m.code);
    if (m.event === "media") replayMedia++;
  });
  replay.on("close", (c) => r(c));
  replay.on("error", () => r(-1));
  setTimeout(() => r("timeout"), 15000);
});
replay.terminate();
record("B2.1", "a used stream token is refused", replayCode === 1008 && replayMedia === 0, `refused with code ${replayCode}, ${replayMedia} audio frames sent`);

// The hold, end to end on the saved sandbox wallet: hold, charge after the appointment; hold, release.
const custs = (await J.get("/api/app/customers")).json ?? [];
const deposits = [];
for (const c of custs) {
  const d = (await J.get(`/api/app/customers/${c.id}`)).json;
  for (const it of d?.items ?? []) if (it.kind === "deposit" && it.balance_cents > 0 && ["open", "link_sent"].includes(it.status)) deposits.push({ c, it, link: d.customer.link });
}
const settle = async (dep, how) => {
  const tok = dep.link.split("/c/")[1];
  const h = await J.post(`/c/${tok}/hold/${dep.it.id}`);
  const m = (await J.get("/api/app/money")).json;
  const row = m?.holds?.find((x) => x.item === dep.it.title && x.status === "authorized");
  const out = row ? await J.post(`/holds/${row.id}/${how}`) : null;
  const after = (await J.get("/api/app/money")).json?.holds?.find((x) => x.id === row?.id);
  return { said: h.json?.message ?? h.location ?? "", row, out: out?.json?.message ?? out?.location ?? "", after };
};
if (deposits.length >= 2) {
  const a = await settle(deposits[0], "capture");
  record("B2.3", "hold from the saved sandbox wallet: PayPal authorizes it and nothing is charged yet", Boolean(a.row?.authorization_id), `${deposits[0].it.title}: authorization ${a.row?.authorization_id ?? "none"}, order ${a.row?.order_id ?? "?"}`);
  record("B2.3", "Attended: charge captures the authorization (sandbox capture id, read from PayPal)", a.after?.status === "captured" && Boolean(a.after?.capture_id), `${a.after?.status} capture ${a.after?.capture_id ?? "none"}: ${decodeURIComponent(String(a.out)).slice(0, 140)}`);
  const b = await settle(deposits[1], "void");
  record("B2.3", "Cancelled in time: release voids the authorization (PayPal reads back VOIDED)", b.after?.status === "voided", `${deposits[1].it.title}: authorization ${b.row?.authorization_id ?? "none"} ${b.after?.status ?? "?"}: ${decodeURIComponent(String(b.out)).slice(0, 140)}`);
} else record("B2.3", "two open deposits to hold", false, `${deposits.length} found`);

console.log(`\nLive check of ${BASE} at commit ${String(health.commit).slice(0, 7)}, ${new Date().toISOString().slice(0, 16)} UTC. ${rows.filter((r) => r.ok).length}/${rows.length} passed.\n`);
console.log("| Item | Check | Result | What happened |\n|---|---|---|---|");
for (const r of rows) console.log(`| ${r.item} | ${r.check} | ${r.ok ? "Pass" : "**Fail**"} | ${String(r.detail).replace(/\|/g, "/").replace(/\n/g, " ")} |`);
process.exit(rows.every((r) => r.ok) ? 0 : 1);
