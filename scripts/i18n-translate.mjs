// Fills missing translations in web/src/i18n/<lang>.json with an AI model and a fixed glossary (spec B2). Existing
// entries are never overwritten, so a person's corrections stay. Every result is checked: placeholders must match
// and brand names must survive, or the entry is left missing and the i18n check keeps failing.
// Usage: node --env-file=.env scripts/i18n-translate.mjs [hi-IN id-ID pt-BR]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL_READ || "gpt-6.1-sol";
const BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/$/, "");
if (!KEY) { console.error("OPENAI_API_KEY is not set"); process.exit(2); }

export const GLOSSARY = {
  "hi-IN": `Natural, simple Hindi as used in Indian banking and shopping apps (Devanagari). Common English loan words are fine where Indians use them (कॉल, लिंक, इनवॉइस, डेमो, ऐप). Glossary: owner = मालिक; front desk = फ़्रंट डेस्क; customer = ग्राहक; pay link = पेमेंट लिंक; invoice = इनवॉइस; refund = रिफ़ंड; hold (money held on a card, charged later) = होल्ड; deposit = डिपॉज़िट; instalment plan = किस्तों का प्लान; consent = सहमति; approve = मंज़ूर करें; decline = मना करें; rules = नियम; limit = सीमा; scam = धोखाधड़ी; Needs you (a page name) = आपकी ज़रूरत; Today (page) = आज; Calls (page) = कॉल; Money (page) = पैसा; Ask (page) = पूछें; evidence = सबूत; kill switch = किल स्विच; simulator = सिम्युलेटर. Use आप for "you".`,
  "id-ID": `Natural, plain Bahasa Indonesia as used in Indonesian banking and shopping apps. Glossary: owner = pemilik; front desk = resepsionis; customer = pelanggan; pay link = tautan pembayaran; invoice = invoice; refund = pengembalian dana; hold (money held on a card, charged later) = dana ditahan; deposit = deposit; instalment plan = cicilan; consent = persetujuan; approve = Setujui; decline = Tolak; rules = aturan; limit = batas; scam = penipuan; Needs you (a page name) = Perlu Anda; Today (page) = Hari ini; Calls (page) = Panggilan; Money (page) = Uang; Ask (page) = Tanya; evidence = bukti; kill switch = tombol henti; simulator = simulator. Use "Anda" for "you".`,
  "pt-BR": `Natural Brazilian Portuguese as used in Brazilian banking and shopping apps. Glossary: owner = dono; front desk = recepção; customer = cliente; pay link = link de pagamento; invoice = fatura; refund = reembolso; hold (money held on a card, charged later) = pré-autorização; deposit = sinal; instalment plan = parcelamento; consent = consentimento; approve = Aprovar; decline = Recusar; rules = regras; limit = limite; scam = golpe; Needs you (a page name) = Precisa de você; Today (page) = Hoje; Calls (page) = Ligações; Money (page) = Dinheiro; Ask (page) = Perguntar; evidence = evidências; kill switch = botão de parada; simulator = simulador. Use "você".`,
};
const RULES = `You translate the user interface of Callback, a web app where an AI voice agent makes payment calls (deposits, overdue invoices, refunds) for a small studio, with PayPal moving the money.
Rules:
- Translate each English string into the target language. Keep it short and plain; it is UI text.
- Keep every {placeholder} exactly as written (same names, same braces); move it to where the grammar needs it.
- Never translate: Callback, PayPal, MCP, GPT-Live, gpt-live-1, Telegram, WhatsApp, SMS, OpenAI, Twilio, Render, GitHub, axe-core, WCAG, JSON, CSV, API, URL, HTTP codes, file paths, code identifiers, model names, amounts, or text in backticks.
- A string that starts or ends with a space, a comma, a colon or "·" is a fragment joined to other text: keep that leading or trailing punctuation and spacing.
- Keep the meaning exact, especially for money, consent and safety text. Do not add or drop information.
- The "where" field says which screen the string is on; use it for context only.`;
const KEEP = ["Callback", "PayPal", "MCP", "GPT-Live", "gpt-live-1"];
const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

async function translate(lang, batch) {
  const body = {
    model: MODEL,
    instructions: `${RULES}\nTarget language: ${lang}. ${GLOSSARY[lang]}`,
    input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(batch.map((b, i) => ({ i, en: b.en, where: b.where }))) }] }],
    text: { format: { type: "json_schema", name: "translations", strict: true, schema: { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", items: { type: "object", additionalProperties: false, required: ["i", "text"], properties: { i: { type: "integer" }, text: { type: "string" } } } } } } } },
    max_output_tokens: 16000,
    reasoning: { effort: "low" },
    store: false,
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${BASE}/v1/responses`, { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; }
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    const part = (data.output ?? []).find((o) => o.type === "message")?.content?.find((c) => c.type === "output_text");
    if (!part?.text) throw new Error(`no text (${data.status})`);
    return { items: JSON.parse(part.text).items, usage: data.usage };
  }
  throw new Error("OpenAI kept failing");
}

const langs = process.argv.slice(2).length ? process.argv.slice(2) : ["hi-IN", "id-ID", "pt-BR"];
const tmp = mkdtempSync(join(tmpdir(), "cb-i18n-"));
try {
  execFileSync("node", [join(ROOT, "scripts/i18n-check.mjs"), "--keys", join(tmp, "keys.json"), "--missing", join(tmp, "missing.json")], { stdio: "ignore" });
} catch { /* the check fails while keys are missing; that is why we are here */ }
const where = JSON.parse(readFileSync(join(tmp, "keys.json"), "utf8"));
const missing = JSON.parse(readFileSync(join(tmp, "missing.json"), "utf8"));
let tin = 0, tout = 0;
await Promise.all(langs.map(async (lang) => {
  const file = join(ROOT, "web/src/i18n", `${lang}.json`);
  const dict = JSON.parse(readFileSync(file, "utf8"));
  const todo = (missing[lang] ?? []).map((en) => ({ en, where: where[en] ?? "" }));
  const batches = [];
  for (let i = 0; i < todo.length; i += 50) batches.push(todo.slice(i, i + 50));
  let rejected = 0;
  for (let i = 0; i < batches.length; i += 4) {
    const results = await Promise.all(batches.slice(i, i + 4).map((b) => translate(lang, b).then((r) => ({ b, r }))));
    for (const { b, r } of results) {
      tin += r.usage?.input_tokens ?? 0;
      tout += r.usage?.output_tokens ?? 0;
      for (const it of r.items) {
        const en = b[it.i]?.en;
        if (!en || dict[en]) continue;
        const okPh = ph(it.text) === ph(en);
        const okKeep = KEEP.every((k) => !en.includes(k) || it.text.includes(k));
        if (okPh && okKeep && it.text.trim()) dict[en] = it.text;
        else rejected++;
      }
    }
    writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(dict).sort(([a], [b]) => a.localeCompare(b))), null, 1) + "\n");
    console.log(`${lang}: ${Math.min(i + 4, batches.length)}/${batches.length} batches`);
  }
  console.log(`${lang}: done, ${todo.length - rejected} added, ${rejected} rejected by the checks`);
}));
console.log(`tokens: ${tin} in, ${tout} out (${MODEL})`);
