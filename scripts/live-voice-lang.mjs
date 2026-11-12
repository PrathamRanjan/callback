// Live check for calls in four languages (spec "Callback-specific": real calls in four languages, the caller's language
// detected, transcripts kept as spoken plus a translation for the owner). A robot stands in for Twilio, as in
// live-voice-check.mjs: it opens the phone-bridge socket with a test-line token and speaks a customer line recorded
// with macOS `say` in Hindi (Lekha), Indonesian (Damayanti) and Brazilian Portuguese (Luciana). Everything after the
// socket is the real path: GPT-Live hears it, the server decides, the transcript is stored, the AI translates it.
// The demo customers are on record as English speakers, so the greeting is in English and the switch is the test.
// Usage: node --env-file=.env scripts/live-voice-lang.mjs [base url] [hi-IN,id-ID,pt-BR]
// Needs CB_ADMIN_KEY (the test line is operator-only). Prints a Markdown table for the README.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

const BASE = (process.argv[2] ?? "https://pph-callback.onrender.com").replace(/\/$/, "");
const ONLY = (process.argv[3] ?? "hi-IN,id-ID,pt-BR").split(",");
const ADMIN = process.env.CB_ADMIN_KEY ?? "";
const DIR = "data/voice-lang";
mkdirSync(DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
const record = (lang, check, ok, detail) => {
  rows.push({ lang, check, ok, detail });
  console.error(`${ok ? "PASS" : "FAIL"}  ${lang}: ${check} — ${detail}`);
};

// What the robot says, and how to tell the agent answered in that language.
const LINES = {
  "hi-IN": {
    voice: "Lekha",
    l1: "हाँ, मैं ही बोल रही हूँ। क्या आप मुझे पेमेंट का लिंक भेज सकते हैं? मैं आज ही भुगतान कर दूँगी।",
    l2: "ठीक है, बहुत धन्यवाद। नमस्ते।",
    is: (s) => (s.match(/[ऀ-ॿ]/g) ?? []).length >= 6,
  },
  "id-ID": {
    voice: "Damayanti",
    l1: "Halo, ya saya sendiri. Bisa kirim tautan pembayaran? Saya mau bayar hari ini.",
    l2: "Baik, terima kasih banyak. Sampai jumpa.",
    is: (s) => (s.match(/\b(saya|anda|ibu|bapak|terima kasih|tautan|pembayaran|bisa|untuk|dengan|akan|sudah|ini|kami|yang)\b/gi) ?? []).length >= 3,
  },
  "pt-BR": {
    voice: "Luciana",
    l1: "Oi, sou eu sim. Você pode me mandar o link de pagamento? Quero pagar hoje.",
    l2: "Tá bom, muito obrigada. Tchau.",
    is: (s) => (s.match(/\b(você|voce|obrigad[oa]|pagamento|link|para|com|sim|enviar|enviei|agora|seu|sua|está|não|posso|vou)\b/gi) ?? []).length >= 3,
  },
};

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
function wav(lang, k, text) {
  const f = join(DIR, `${lang}-${k}.wav`);
  execFileSync("say", ["-v", LINES[lang].voice, "-o", f, "--file-format=WAVE", "--data-format=ulaw@8000", text]);
  return ulaw(f);
}

// One private demo for all three languages (the site allows 5 new demos an hour per address); each language takes
// another planned call in it.
const J = new Client();
async function one(lang) {
  const L = LINES[lang];
  const calls = (await J.get("/api/app/calls")).json;
  if (!Array.isArray(calls)) throw new Error("not signed in to a demo (the per-address demo limit may be reached)");
  const call = calls.find((c) => c.purpose === "confirm_deposit" && c.status === "planned") ?? calls.find((c) => c.status === "planned");
  if (!call) return record(lang, "a planned call exists in a fresh demo", false, calls.map((c) => `${c.purpose}:${c.status}`).join(", "));
  const tl = await J.postJson(`/api/app/calls/${call.id}/live/test-line`, {}, { "x-admin-key": ADMIN });
  if (tl.status !== 200) return record(lang, "the test line starts the call", false, `HTTP ${tl.status} ${tl.json?.message ?? ""}`);

  const tw = new WebSocket(tl.json.stream_url);
  let agentBytes = 0;
  let lastAgentAudio = 0;
  let closed = false;
  tw.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.event === "media") { agentBytes += Buffer.from(m.media.payload, "base64").length; lastAgentAudio = Date.now(); }
  });
  tw.on("close", () => { closed = true; });
  await new Promise((r, j) => { tw.on("open", r); tw.on("error", j); });
  tw.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
  tw.send(JSON.stringify({ event: "start", sequenceNumber: "1", start: { streamSid: "MZlang", callSid: "CAlang", tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 }, customParameters: { call: call.id, token: tl.json.token } }, streamSid: "MZlang" }));
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
    tw.send(JSON.stringify({ event: "media", streamSid: "MZlang", media: { track: "inbound", payload: frame.toString("base64") } }));
  }, 20);
  async function agentDone(maxMs = 30000, quiet = 1800) {
    const start = Date.now();
    const before = agentBytes;
    while (Date.now() - start < maxMs) {
      await sleep(200);
      if (closed) return;
      if (agentBytes > before && Date.now() - lastAgentAudio > quiet) return;
    }
  }
  await agentDone(25000);
  queue = Buffer.concat([queue, wav(lang, "l1", L.l1)]);
  await sleep(3000);
  await agentDone(40000);
  queue = Buffer.concat([queue, wav(lang, "l2", L.l2)]);
  await sleep(3000);
  await agentDone(30000);
  await sleep(1500);
  if (!closed) tw.send(JSON.stringify({ event: "stop", streamSid: "MZlang", stop: { callSid: "CAlang" } }));
  await sleep(2500);
  clearInterval(pump);
  tw.terminate();

  const s = (await J.get(`/api/app/calls/${call.id}`)).json;
  const tr = s?.call?.transcript ?? [];
  const cust = tr.filter((x) => x.who === "customer").map((x) => x.text);
  const agentAfter = (() => {
    const i = tr.findIndex((x) => x.who === "customer");
    return i < 0 ? [] : tr.slice(i + 1).filter((x) => x.who === "agent").map((x) => x.text);
  })();
  record(lang, "the customer's words are stored as spoken", cust.length >= 1 && cust.some(L.is), cust.map((l) => `"${l.slice(0, 70)}"`).join(" | ") || "no customer line");
  record(lang, "code detected the caller's language and kept it on the call", s?.call?.lang === lang, `call.lang = ${s?.call?.lang}`);
  record(lang, "the agent switched to the caller's language", agentAfter.length > 0 && agentAfter.every(L.is), agentAfter.map((l) => `"${l.slice(0, 90)}"`).join(" | ") || "the agent said nothing after the customer spoke");

  // The link texted during the call goes out in the language the caller spoke (and PayPal's page opens in it: the
  // same language value sets the order's locale, which PayPal does not echo back, so the text is what can be seen).
  const msgs = ((await J.get("/api/app/messages")).json?.recent ?? []).filter((m) => /^out/i.test(m.direction ?? "") && /paypal/i.test(m.body ?? ""));
  const sms = msgs.sort((x, y) => String(y.at).localeCompare(String(x.at)))[0]?.body ?? "";
  record(lang, "the PayPal link texted during the call is in the caller's language", L.is(sms), sms ? `"${sms.replace(/https?:\/\/\S+/g, "<link>").slice(0, 120)}"` : "no PayPal text sent");

  const t = await J.postJson(`/api/app/calls/${call.id}/translate`, { lang: "en" });
  const lines = t.json?.translation?.lines ?? t.json?.translation ?? [];
  const flat = Array.isArray(lines) ? lines.map((x) => (typeof x === "string" ? x : x.text ?? "")).join(" ") : JSON.stringify(lines);
  record(lang, "the owner gets an English translation, labelled machine-translated, and the original is unchanged", t.status === 200 && /\b(the|you|link|payment|pay|thank)\b/i.test(flat) && !/[ऀ-ॿ]{3}/.test(flat) && JSON.stringify((await J.get(`/api/app/calls/${call.id}`)).json?.call?.transcript) === JSON.stringify(tr), `HTTP ${t.status}: "${flat.slice(0, 140)}"`);
  record(lang, "the call ended", ["ended", "done", "completed"].includes(s?.call?.status), `status ${s?.call?.status}, outcome ${s?.call?.outcome}`);
}

const health = await fetch(`${BASE}/healthz`).then((r) => r.json());
console.error(`target ${BASE}, commit ${String(health.commit).slice(0, 7)}`);
const si = await J.post("/demo/signin-as", { role: "owner" });
if (/err=/.test(si.location ?? "") || si.status >= 400) { console.error(`no demo: HTTP ${si.status} ${si.json?.message ?? decodeURIComponent((si.location ?? "").split("err=")[1] ?? "")}`); process.exit(1); }
for (const l of ONLY) {
  try { await one(l); } catch (e) { record(l, "the check ran", false, (e).message); }
}
console.log(`\n| Language | Check | Result | What was seen |\n|---|---|---|---|`);
for (const r of rows) console.log(`| ${r.lang} | ${r.check} | ${r.ok ? "pass" : "FAIL"} | ${String(r.detail).replace(/\|/g, "/").replace(/\n/g, " ")} |`);
process.exit(rows.every((r) => r.ok) ? 0 : 1);
