/**
 * Languages (spec B). The web pages carry their own text (web/src/i18n); this file is the server's side: which language
 * a request, a person or a call is in, how to tell the AI to answer in it, and the few lines the server itself writes to
 * customers (texts and the voice agent's set lines).
 *
 * Nothing here decides money. Code that checks what was said uses codes (outcome, signal names), never these words.
 */
import type { Request } from "express";

export type Lang = "en" | "hi-IN" | "id-ID" | "pt-BR";
export const LANGS: Lang[] = ["en", "hi-IN", "id-ID", "pt-BR"];
export const LANG_NAME: Record<Lang, string> = { en: "English", "hi-IN": "Hindi", "id-ID": "Indonesian", "pt-BR": "Brazilian Portuguese" };
/** PayPal's checkout locale (BCP 47). PayPal has no Hindi checkout page, so Hindi gets English (India) and the page says so. */
export const PAYPAL_LOCALE: Record<Lang, string> = { en: "en-US", "hi-IN": "en-IN", "id-ID": "id-ID", "pt-BR": "pt-BR" };
/** The locale to send PayPal for a customer, or undefined for English (English orders are sent exactly as before). */
export function paypalLocale(lang: string | null | undefined): string | undefined {
  const l = normLang(lang);
  return l && l !== "en" ? PAYPAL_LOCALE[l] : undefined;
}
/** Twilio <Say> voices for the scripted phone line (Amazon Polly through Twilio). */
export const TWILIO_SAY: Record<Lang, { language: string; voice: string }> = {
  en: { language: "en-US", voice: "Polly.Joanna" },
  "hi-IN": { language: "hi-IN", voice: "Polly.Aditi" },
  "id-ID": { language: "id-ID", voice: "Google.id-ID-Standard-A" },
  "pt-BR": { language: "pt-BR", voice: "Polly.Camila" },
};

export function normLang(v: unknown): Lang | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim().toLowerCase();
  if (s.startsWith("hi")) return "hi-IN";
  if (s.startsWith("id") || s === "in" || s.startsWith("in-")) return "id-ID";
  if (s.startsWith("pt")) return "pt-BR";
  if (s.startsWith("en")) return "en";
  return null;
}

/** The language of a web request: ?lang=, then the cb_lang cookie the pages set, then Accept-Language. */
export function langOf(req: Request): Lang {
  const q = normLang(req.query?.lang);
  if (q) return q;
  const c = normLang((req as Request & { cookies?: Record<string, string> }).cookies?.cb_lang);
  if (c) return c;
  for (const part of String(req.headers["accept-language"] ?? "").split(",")) {
    const n = normLang(part.split(";")[0]);
    if (n) return n;
  }
  return "en";
}

/** The sentence added to an AI prompt so the reply comes back in the reader's language. */
export function answerIn(lang: Lang): string {
  if (lang === "en") return "";
  return `Write every sentence of your reply in ${LANG_NAME[lang]} (${lang}). Keep people's names, business names, item titles, amounts, dates, ids and the words PayPal and Callback exactly as they appear in the tools.`;
}

// Words that mark a language when a caller speaks (spec item 5.1: detect the caller's language from the first words).
// Scored, not matched once: a short "ok" or a name must not flip a call.
const MARKS: Record<Exclude<Lang, "en" | "hi-IN">, RegExp> = {
  "id-ID": /\b(saya|tidak|ya|bisa|sudah|belum|terima kasih|halo|selamat|apa|ini|itu|untuk|dengan|bayar|tagihan|nanti|baik|mau|tolong|siapa|boleh)\b/gi,
  "pt-BR": /\b(sim|não|nao|obrigad[oa]|olá|ola|oi|bom dia|boa tarde|eu|você|voce|pagar|pagamento|quem|agora|depois|tudo bem|pode|está|esta|isso|fatura|tchau)\b/gi,
};
const EN = /\b(yes|no|the|you|okay|thanks|thank you|hello|hi|what|who|pay|now|later|can|is|this|that|please|sure|bye)\b/gi;

/** Which of the four languages a short piece of speech is in, or null when it can't tell yet. */
export function detectLang(text: string): Lang | null {
  const s = String(text ?? "");
  if (!s.trim()) return null;
  const deva = (s.match(/[ऀ-ॿ]/g) ?? []).length;
  if (deva >= 2) return "hi-IN";
  // Romanised Hindi from a speech model ("haan", "nahin", "abhi", "paisa").
  const hinglish = (s.match(/\b(haan|haa|nahin|nahi|abhi|kaun|kya|theek|thik|paisa|paise|baad mein|dhanyavaad|ji|hoon|hai)\b/gi) ?? []).length;
  const scores: [Lang, number][] = [
    ["hi-IN", hinglish * 1.2],
    ["id-ID", (s.match(MARKS["id-ID"]) ?? []).length],
    ["pt-BR", (s.match(MARKS["pt-BR"]) ?? []).length + (s.match(/[ãõç]/gi) ?? []).length],
    ["en", (s.match(EN) ?? []).length],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  const [best, second] = scores;
  if (best[1] < 1 || best[1] === second[1]) return null;
  return best[0];
}

/** Amounts as people say them in the four languages: "$420", "420 dollars", "420 डॉलर", "420 dolar", "US$ 420", "420 dólares". */
export const MONEY_WORDS = /(?:US?\$|R\$|\$)\s?(\d[\d,.]*\d|\d)|\b(\d[\d,.]*\d|\d)\s?(?:dollars?|bucks|डॉलर|dolar|dólares?|dolares?|reais|rupees?|रुपये|rupiah)/gi;
/** The amounts in a spoken line, as "420.00". Handles "1.234,56" (pt-BR, id-ID) and "1,234.56" (en). */
export function amountsSpoken(s: string): string[] {
  return [...String(s).matchAll(MONEY_WORDS)].map((m) => {
    let n = (m[1] ?? m[2]).trim();
    if (/,\d{1,2}$/.test(n)) n = n.replace(/\./g, "").replace(",", ".");
    else if (/^\d{1,3}(\.\d{3})+$/.test(n)) n = n.replace(/\./g, ""); // "1.234" is one thousand two hundred and thirty-four in pt-BR and id-ID
    else n = n.replace(/,/g, "");
    return Number(n).toFixed(2);
  });
}

type Line = "hold_sent" | "ai_failed" | "stop" | "wrong_person" | "abuse" | "time_cap";
const LINES: Record<Line, Record<Lang, string>> = {
  hold_sent: {
    en: "Done. I've texted you a PayPal link to hold {amount} for {item}. It's charged only if you attend, and released if you cancel in time.",
    "hi-IN": "हो गया। मैंने आपको {item} के लिए {amount} होल्ड करने का PayPal लिंक भेज दिया है। पैसा तभी कटेगा जब आप आएँगे, और समय पर रद्द करने पर छोड़ दिया जाएगा।",
    "id-ID": "Selesai. Saya sudah mengirim tautan PayPal untuk menahan {amount} untuk {item}. Dana hanya ditagih jika Anda hadir, dan dilepas jika Anda membatalkan tepat waktu.",
    "pt-BR": "Pronto. Enviei por mensagem um link do PayPal para pré-autorizar {amount} para {item}. Só é cobrado se você comparecer, e é liberado se você cancelar a tempo.",
  },
  ai_failed: {
    en: "Sorry, I can't continue this call right now. The office will call you back. Goodbye.",
    "hi-IN": "माफ़ कीजिए, मैं अभी यह कॉल जारी नहीं रख सकती। ऑफ़िस आपको वापस कॉल करेगा। नमस्ते।",
    "id-ID": "Maaf, saya tidak bisa melanjutkan panggilan ini sekarang. Kantor akan menelepon Anda kembali. Sampai jumpa.",
    "pt-BR": "Desculpe, não consigo continuar esta ligação agora. O escritório vai ligar de volta. Tchau.",
  },
  stop: {
    en: "Understood. We won't call you again. Goodbye.",
    "hi-IN": "समझ गई। हम आपको फिर कॉल नहीं करेंगे। नमस्ते।",
    "id-ID": "Baik, saya mengerti. Kami tidak akan menelepon Anda lagi. Sampai jumpa.",
    "pt-BR": "Entendido. Não vamos ligar para você de novo. Tchau.",
  },
  wrong_person: {
    en: "I'm sorry to have bothered you. Goodbye.",
    "hi-IN": "परेशान करने के लिए माफ़ी चाहती हूँ। नमस्ते।",
    "id-ID": "Maaf sudah mengganggu. Sampai jumpa.",
    "pt-BR": "Desculpe o incômodo. Tchau.",
  },
  abuse: {
    en: "I'm going to end the call now. Goodbye.",
    "hi-IN": "मैं अब कॉल ख़त्म कर रही हूँ। नमस्ते।",
    "id-ID": "Saya akan mengakhiri panggilan sekarang. Sampai jumpa.",
    "pt-BR": "Vou encerrar a ligação agora. Tchau.",
  },
  time_cap: {
    en: "We've reached the time limit for this demo call, so I'll stop here. Thank you. Goodbye.",
    "hi-IN": "इस डेमो कॉल का समय पूरा हो गया है, इसलिए मैं यहीं रुकती हूँ। धन्यवाद। नमस्ते।",
    "id-ID": "Waktu untuk panggilan demo ini sudah habis, jadi saya berhenti di sini. Terima kasih. Sampai jumpa.",
    "pt-BR": "Chegamos ao limite de tempo desta ligação de demonstração, então vou parar aqui. Obrigada. Tchau.",
  },
};
/** A line the server itself says, in the call's language. {amount} and {item} are filled from the record. */
export function line(k: Line, lang: Lang | null | undefined, vars: Record<string, string> = {}): string {
  const s = LINES[k][lang ?? "en"] ?? LINES[k].en;
  return s.replace(/\{(\w+)\}/g, (m, v) => vars[v] ?? m);
}

/** Amounts written for the customer in their language. The amount itself is always US dollars. */
export function usd(cents: number, lang: Lang | null | undefined = "en"): string {
  return new Intl.NumberFormat(lang && lang !== "en" ? lang : "en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

const TEXTS = {
  pay_link: {
    en: "{business}: here is your PayPal link for {amount} ({item}): {url}",
    "hi-IN": "{business}: {item} के लिए {amount} का आपका PayPal लिंक: {url}",
    "id-ID": "{business}: ini tautan PayPal Anda untuk {amount} ({item}): {url}",
    "pt-BR": "{business}: aqui está seu link do PayPal de {amount} ({item}): {url}",
  },
  hold_link: {
    en: "{business}: hold {amount} for {item} with PayPal. Charged only if you attend: {url}",
    "hi-IN": "{business}: {item} के लिए PayPal से {amount} होल्ड करें। पैसा तभी कटेगा जब आप आएँगे: {url}",
    "id-ID": "{business}: tahan {amount} untuk {item} dengan PayPal. Hanya ditagih jika Anda hadir: {url}",
    "pt-BR": "{business}: pré-autorize {amount} para {item} com o PayPal. Só é cobrado se você comparecer: {url}",
  },
  plan_link: {
    en: "{business}: your payment plan ({plan}) is ready to approve: {url}",
    "hi-IN": "{business}: आपका किस्तों का प्लान ({plan}) मंज़ूरी के लिए तैयार है: {url}",
    "id-ID": "{business}: rencana cicilan Anda ({plan}) siap disetujui: {url}",
    "pt-BR": "{business}: seu parcelamento ({plan}) está pronto para aprovação: {url}",
  },
  account: {
    en: "{business}: your account page: {url}",
    "hi-IN": "{business}: आपके खाते का पेज: {url}",
    "id-ID": "{business}: halaman akun Anda: {url}",
    "pt-BR": "{business}: a página da sua conta: {url}",
  },
} as const;
/** A text message to a customer, in the customer's language. */
export function customerText(k: keyof typeof TEXTS, lang: Lang | null | undefined, vars: Record<string, string>): string {
  const s: string = TEXTS[k][lang ?? "en"] ?? TEXTS[k].en;
  return s.replace(/\{(\w+)\}/g, (m, v) => vars[v] ?? m);
}
