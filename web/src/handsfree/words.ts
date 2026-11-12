/**
 * What hands-free hears and what it refuses to do on its own (spec A6). Plain functions, unit-tested.
 *
 * "Stop" is matched here, in code, in every language, before anything else: it never waits for a model, a wake word
 * or a network. Commands are a small fixed grammar per language ("open calls", "this one", "scroll down"), split on
 * "then" and capped at 10 steps. Anything else becomes a question for Ask, where the server's own tools and gate
 * decide what may happen.
 *
 * riskOf() decides, in code, which presses need a confirm card: money, refunds, calls, deletes, cancels, sends,
 * disputes and approvals. A model never decides that.
 */

export type HfLang = "en" | "hi-IN" | "id-ID" | "pt-BR";

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFC")
    .replace(/[.,!?;:"“”'’()।]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Every language's stop words are checked whatever the page language is: a person may fall back on their own. */
const STOP = ["stop", "stop listening", "रुको", "रुकिए", "रुक जाओ", "बंद करो", "ruko", "rukiye", "band karo", "berhenti", "hentikan", "pare", "parar", "pára", "chega"];
const STOP_RE = new RegExp(`(^|\\s)(${STOP.map((w) => w.replace(/\s+/g, "\\s+")).join("|")})(\\s|$)`, "u");

export function isStop(text: string): boolean {
  return STOP_RE.test(norm(text));
}

export const WAKE: Record<HfLang, string[]> = {
  en: ["callback", "call back", "hey callback"],
  "hi-IN": ["callback", "कॉलबैक", "कॉल बैक"],
  "id-ID": ["callback", "kolbek"],
  "pt-BR": ["callback", "côlbéque", "colbeque"],
};

/** Strips a leading wake word. Returns null if the text doesn't start with one. */
export function afterWake(text: string, lang: HfLang): string | null {
  const s = norm(text);
  for (const w of [...WAKE[lang], ...WAKE.en]) {
    if (s === w) return "";
    if (s.startsWith(`${w} `)) return s.slice(w.length + 1);
  }
  return null;
}

export type Step =
  | { kind: "press" }
  | { kind: "go"; to: string }
  | { kind: "back" }
  | { kind: "scroll"; dir: "up" | "down" }
  | { kind: "next" }
  | { kind: "prev" }
  | { kind: "confirm" }
  | { kind: "cancel" }
  | { kind: "calibrate" }
  | { kind: "ask"; q: string };

export const MAX_STEPS = 10;

const PAGES: Record<string, string[]> = {
  "/today": ["today", "home", "आज", "aaj", "hari ini", "beranda", "hoje", "início", "inicio"],
  "/calls": ["calls", "call list", "कॉल", "कॉल्स", "calls list", "panggilan", "telepon", "ligações", "ligacoes", "chamadas"],
  "/customers": ["customers", "ग्राहक", "grahak", "pelanggan", "clientes"],
  "/approvals": ["approvals", "मंज़ूरी", "मंजूरी", "manzoori", "persetujuan", "aprovações", "aprovacoes"],
  "/money": ["money", "पैसे", "paise", "uang", "dinheiro"],
  "/rules": ["rules", "नियम", "niyam", "aturan", "regras"],
  "/safety": ["safety", "scam guard", "सुरक्षा", "keamanan", "segurança", "seguranca"],
  "/messages": ["messages", "संदेश", "मैसेज", "pesan", "mensagens"],
  "/ask": ["ask", "पूछो", "tanya", "perguntar"],
  "/accessibility": ["accessibility", "सुलभता", "aksesibilitas", "acessibilidade"],
};

interface Grammar { then: string[]; press: string[]; go: string[]; back: string[]; down: string[]; up: string[]; next: string[]; prev: string[]; confirm: string[]; cancel: string[]; calibrate: string[]; ask: string[] }
const G: Record<HfLang, Grammar> = {
  en: { then: ["then", "and then"], press: ["this one", "that one", "click", "press", "select", "choose this", "click this", "press this", "click it", "press it"], go: ["go to", "open", "show"], back: ["back", "go back"], down: ["scroll down", "down", "page down"], up: ["scroll up", "up", "page up"], next: ["next"], prev: ["previous", "back one"], confirm: ["confirm", "yes", "yes confirm", "do it"], cancel: ["cancel", "no", "never mind"], calibrate: ["calibrate", "recalibrate"], ask: ["ask"] },
  "hi-IN": { then: ["फिर", "उसके बाद", "phir", "uske baad"], press: ["यह वाला", "ये वाला", "यह", "ये", "इसे", "इसको", "दबाओ", "दबाइए", "क्लिक", "क्लिक करो", "yeh wala", "ye wala", "isko", "ise", "dabao", "click karo"], go: ["खोलो", "खोलिए", "पर जाओ", "दिखाओ", "kholo", "pe jao", "par jao", "dikhao"], back: ["पीछे", "वापस", "peeche", "wapas"], down: ["नीचे", "नीचे करो", "neeche"], up: ["ऊपर", "ऊपर करो", "upar"], next: ["अगला", "agla"], prev: ["पिछला", "pichla"], confirm: ["हाँ", "हां", "पक्का", "पुष्टि करो", "haan", "pakka", "confirm"], cancel: ["नहीं", "रद्द करो", "रहने दो", "nahi", "nahin", "rehne do", "cancel"], calibrate: ["कैलिब्रेट", "calibrate"], ask: ["पूछो", "poochho", "pucho"] },
  "id-ID": { then: ["lalu", "kemudian", "terus", "setelah itu"], press: ["yang ini", "ini", "itu", "klik", "tekan", "pilih", "klik ini", "tekan ini"], go: ["buka", "ke", "pergi ke", "tampilkan"], back: ["kembali", "mundur"], down: ["gulir ke bawah", "ke bawah", "turun"], up: ["gulir ke atas", "ke atas", "naik"], next: ["berikutnya", "selanjutnya"], prev: ["sebelumnya"], confirm: ["ya", "konfirmasi", "iya", "setuju"], cancel: ["batal", "tidak", "jangan", "batalkan"], calibrate: ["kalibrasi"], ask: ["tanya", "tanyakan"] },
  "pt-BR": { then: ["depois", "então", "entao", "e depois"], press: ["este", "esse", "este aqui", "esse aqui", "isso", "clique", "clicar", "aperte", "apertar", "selecione", "escolher"], go: ["abrir", "abra", "ir para", "vá para", "va para", "mostrar", "mostre"], back: ["voltar", "volte"], down: ["rolar para baixo", "role para baixo", "descer", "para baixo"], up: ["rolar para cima", "role para cima", "subir", "para cima"], next: ["próximo", "proximo", "seguinte"], prev: ["anterior"], confirm: ["sim", "confirmar", "confirmo", "pode"], cancel: ["cancelar", "não", "nao", "deixa"], calibrate: ["calibrar"], ask: ["perguntar", "pergunte"] },
};

const has = (s: string, words: string[]) => words.some((w) => s === w);
const startsAny = (s: string, words: string[]) => words.find((w) => s.startsWith(`${w} `));
const endsAny = (s: string, words: string[]) => words.find((w) => s.endsWith(` ${w}`));

function pageIn(s: string): string | null {
  for (const [to, names] of Object.entries(PAGES)) if (names.some((n) => s === n || s.includes(` ${n}`) || s.startsWith(`${n} `) || s.endsWith(` ${n}`))) return to;
  return null;
}

function one(s: string, g: Grammar): Step | null {
  if (!s) return null;
  if (has(s, g.press) || has(s, G.en.press)) return { kind: "press" };
  if (has(s, g.confirm) || has(s, G.en.confirm)) return { kind: "confirm" };
  if (has(s, g.cancel) || has(s, G.en.cancel)) return { kind: "cancel" };
  if (has(s, g.back) || has(s, G.en.back)) return { kind: "back" };
  if (has(s, g.down) || has(s, G.en.down)) return { kind: "scroll", dir: "down" };
  if (has(s, g.up) || has(s, G.en.up)) return { kind: "scroll", dir: "up" };
  if (has(s, g.next) || has(s, G.en.next)) return { kind: "next" };
  if (has(s, g.prev) || has(s, G.en.prev)) return { kind: "prev" };
  if (has(s, g.calibrate) || has(s, G.en.calibrate)) return { kind: "calibrate" };
  const ask = startsAny(s, g.ask) ?? startsAny(s, G.en.ask);
  if (ask) return { kind: "ask", q: s.slice(ask.length + 1) };
  // "open calls" (verb first) or "calls kholo" (Hindi: verb last).
  // A page name alone ("calls") also goes there; a page name inside a question ("who owes money?") does not.
  const verb = startsAny(s, g.go) ?? startsAny(s, G.en.go) ?? endsAny(s, g.go);
  const to = pageIn(s);
  if (to && (verb || Object.values(PAGES).some((names) => names.includes(s)))) return { kind: "go", to };
  return null;
}

/**
 * Parses an utterance into steps. Unknown text becomes one Ask step (the server decides). Returns at most MAX_STEPS;
 * `dropped` counts the rest, so the page can say "I did the first 10".
 */
export function parseCommand(text: string, lang: HfLang): { steps: Step[]; dropped: number } {
  const g = G[lang] ?? G.en;
  const s = norm(text);
  if (!s) return { steps: [], dropped: 0 };
  const seps = [...new Set([...g.then, ...G.en.then])].sort((a, b) => b.length - a.length);
  const parts = s.split(new RegExp(`\\s+(?:${seps.map((w) => w.replace(/\s+/g, "\\s+")).join("|")})\\s+`, "u")).map((p) => p.trim()).filter(Boolean);
  const steps: Step[] = [];
  for (const p of parts) {
    const st = one(p, g);
    if (st) steps.push(st);
    else return { steps: parts.length === 1 ? [{ kind: "ask", q: s }] : steps.concat({ kind: "ask", q: p }).slice(0, MAX_STEPS), dropped: 0 };
  }
  return { steps: steps.slice(0, MAX_STEPS), dropped: Math.max(0, steps.length - MAX_STEPS) };
}

/* ---------------------------------------------------------------- risky presses */

export type Risk = "payment" | "refund" | "call" | "delete" | "cancel" | "send" | "dispute" | "approve" | "reset" | "handover";

/** Callback's own action routes (ActButton puts its route in data-act). Order matters: the first match wins. */
const PATH_RISK: [RegExp, Risk][] = [
  [/refund/, "refund"],
  [/dispute/, "dispute"],
  [/\/settle\/|\/pay\/|\/pay$|\/capture$|\/void$|\/hold\/|\/wallet\/|\/charges$|\/plan\/|invoice|\/money\/negative|webhook\/simulate/, "payment"],
  [/\/place$|call-again|\/retry$/, "call"],
  [/\/say$|\/reply$|\/callback$|\/send/, "send"],
  [/delete|remove|erase/, "delete"],
  [/\/cancel$|\/stop$|\/skip$|\/end$|\/kill$|\/consent$|\/dnc/, "cancel"],
  [/\/approvals\/|decide|autonomy\/adopt|^\/policy$|\/limits$/, "approve"],
  [/\/reset$|fault-ai/, "reset"],
];
const TEXT_RISK: [RegExp, Risk][] = [
  [/refund|reembols|kembalikan dana|रिफ़ंड|रिफंड/i, "refund"],
  [/dispute|contest|sengketa|disputa|विवाद/i, "dispute"],
  [/\bpay\b|payment|charge|capture|deposit|\$\s?\d|US\$|pagar|pagamento|cobrar|bayar|pembayaran|भुगतान|पेमेंट/i, "payment"],
  [/\bcall (now|them|back)|place (the )?call|ligar|panggil|telepon sekarang|कॉल करें|कॉल करो/i, "call"],
  [/delete|remove|hapus|excluir|apagar|हटाएँ|हटाओ|मिटाएँ/i, "delete"],
  [/\bcancel\b|batalkan|cancelar|रद्द/i, "cancel"],
  [/\bsend\b|kirim|enviar|भेजें|भेजो/i, "send"],
  [/approve|setujui|aprovar|मंज़ूर|मंजूर/i, "approve"],
  [/\breset\b|redefinir|atur ulang|रीसेट/i, "reset"],
];

/**
 * Which presses need a confirm card. Reads the element's own marking first (data-risk), then the action route it posts
 * to, then a link that leaves for PayPal, then its words. Returns null for safe presses (navigation, filters, tabs).
 */
export function riskOf(el: { risk?: string | null; path?: string | null; href?: string | null; text?: string | null; external?: boolean }): Risk | null {
  if (el.risk === "none") return null;
  if (el.risk) return el.risk as Risk;
  if (el.href && /(^|\.)paypal\.com/i.test(safeHost(el.href))) return "handover";
  if (el.path) for (const [re, k] of PATH_RISK) if (re.test(el.path)) return k;
  if (el.text) for (const [re, k] of TEXT_RISK) if (re.test(el.text)) return k;
  return null;
}
function safeHost(href: string) {
  try {
    return new URL(href, "http://x").host;
  } catch {
    return "";
  }
}
