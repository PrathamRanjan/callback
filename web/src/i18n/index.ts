/**
 * The language switch (spec B). English text is the key: `t("Ready to call")`. Each other language is a JSON map from
 * the English text to its translation, loaded on demand. A missing entry shows the English text and is counted, so
 * `scripts/i18n-check.mjs` (run in CI and in `npm test`) fails the build when a key has no translation.
 *
 * Switching is instant: the root component holds the language, so changing it re-renders the whole tree in place.
 * Nothing remounts, so typed text and open dialogs survive.
 *
 * `?lang=pseudo` is the pseudo-locale: accented, 30% longer and bracketed, to find untranslated or clipped text.
 */
import { useSyncExternalStore } from "react";
import { store } from "@/lib/hooks";

export type Lang = "en" | "hi-IN" | "id-ID" | "pt-BR" | "pseudo";
export interface LangInfo { code: Exclude<Lang, "pseudo">; name: string; english: string; paypal: string; currency: string; speech: string }
export const LANGS: LangInfo[] = [
  { code: "en", name: "English", english: "English", paypal: "en_US", currency: "USD", speech: "en-US" },
  { code: "hi-IN", name: "हिन्दी", english: "Hindi", paypal: "en_IN", currency: "INR", speech: "hi-IN" },
  { code: "id-ID", name: "Bahasa Indonesia", english: "Indonesian", paypal: "id_ID", currency: "IDR", speech: "id-ID" },
  { code: "pt-BR", name: "Português (Brasil)", english: "Brazilian Portuguese", paypal: "pt_BR", currency: "BRL", speech: "pt-BR" },
];
const CODES = new Set<string>(["en", "hi-IN", "id-ID", "pt-BR", "pseudo"]);
const KEY = "cb-lang";

/** Accepts "hi", "hi-IN", "pt", "pt-BR", "id", "in" (old code for Indonesian), "id-ID", "en-GB"... */
export function normalise(v: string | null | undefined): Lang | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  if (s === "pseudo") return "pseudo";
  if (s.startsWith("hi")) return "hi-IN";
  if (s.startsWith("id") || s === "in" || s.startsWith("in-")) return "id-ID";
  if (s.startsWith("pt")) return "pt-BR";
  if (s.startsWith("en")) return "en";
  return null;
}

function fromUrl(): Lang | null {
  try {
    return normalise(new URLSearchParams(location.search).get("lang"));
  } catch {
    return null;
  }
}
function detect(): Lang {
  const u = fromUrl();
  if (u) return u;
  const saved = normalise(store.get(KEY));
  if (saved && CODES.has(saved)) return saved;
  for (const l of typeof navigator !== "undefined" ? navigator.languages ?? [navigator.language] : []) {
    const n = normalise(l);
    if (n) return n;
  }
  return "en";
}

type Dict = Record<string, string>;
const dicts: Partial<Record<Lang, Dict>> = { en: {} };
const loaders: Record<Exclude<Lang, "en" | "pseudo">, () => Promise<{ default: Dict }>> = {
  "hi-IN": () => import("./hi-IN.json"),
  "id-ID": () => import("./id-ID.json"),
  "pt-BR": () => import("./pt-BR.json"),
};

let lang: Lang = "en";
let ready = true;
const listeners = new Set<() => void>();
const missing = new Set<string>();
const emit = () => listeners.forEach((l) => l());

function applyDocument(l: Lang) {
  const html = document.documentElement;
  html.lang = l === "pseudo" ? "en-XA" : l;
  html.classList.toggle("lang-hi", l === "hi-IN");
  if (l === "hi-IN") void import("@fontsource/noto-sans-devanagari/400.css").then(() => import("@fontsource/noto-sans-devanagari/600.css"));
  document.cookie = `cb_lang=${l === "pseudo" ? "en" : l}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

async function load(l: Lang) {
  if (l === "en" || l === "pseudo" || dicts[l]) return;
  dicts[l] = (await loaders[l]()).default;
}

/** Sets the language: saved on this device and in a cookie the server reads for AI replies and messages. */
export async function setLang(l: Lang, opts: { save?: boolean } = {}) {
  if (opts.save !== false) store.set(KEY, l);
  ready = false;
  try {
    await load(l);
  } finally {
    ready = true;
  }
  lang = l;
  applyDocument(l);
  emit();
  if (opts.save !== false) void fetch("/api/app/me/lang", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ lang: l === "pseudo" ? "en" : l }) }).catch(() => undefined);
}

/** Called once before the first render. */
export async function initLang() {
  const l = detect();
  await setLang(l, { save: Boolean(fromUrl()) });
}

export const currentLang = () => lang;
export const langInfo = (l: Lang = lang): LangInfo => LANGS.find((x) => x.code === l) ?? LANGS[0];
/** For Intl: the pseudo-locale formats like English. */
export const locale = () => (lang === "pseudo" ? "en-US" : lang === "en" ? "en-US" : lang);

export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => lang,
  );
}
export const langReady = () => ready;

const ACCENT: Record<string, string> = { a: "á", e: "é", i: "í", o: "ó", u: "ú", A: "Á", E: "É", I: "Í", O: "Ó", U: "Ú", c: "ç", n: "ñ", y: "ý" };
function pseudo(s: string) {
  const body = s.replace(/\{[^}]+\}|[aeiouAEIOUcny]/g, (m) => (m.length > 1 ? m : ACCENT[m] ?? m));
  // 30% longer, in short runs so the padding wraps like real words do.
  const pad = "·".repeat(Math.max(1, Math.round(s.length * 0.3))).replace(/(.{6})(?=.)/g, "$1 ");
  return `⟦${body}${pad}⟧`;
}

function fill(s: string, vars?: Record<string, unknown> | unknown[]) {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => {
    const v = Array.isArray(vars) ? vars[Number(k)] : (vars as Record<string, unknown>)[k];
    return v === undefined || v === null ? m : String(v);
  });
}

/** Translate. `vars` fills {name} or {0} placeholders after translating, so word order can change per language. */
export function t(en: string, vars?: Record<string, unknown> | unknown[]): string {
  if (lang === "en" || !en) return fill(en, vars);
  if (lang === "pseudo") return fill(pseudo(en), vars);
  const d = dicts[lang];
  const v = d?.[en];
  if (v === undefined) {
    if (d && !missing.has(en)) {
      missing.add(en);
      if (import.meta.env.DEV) console.warn(`[i18n] no ${lang} text for: ${en}`);
    }
    return fill(en, vars);
  }
  return fill(v, vars);
}

/** Marks a module-level string for the key extractor; translate it with t() where it is shown. */
export const tk = <S extends string>(en: S): S => en;

/** "{n} call" / "{n} calls", by the language's own plural rules (Hindi and Portuguese count 0 as singular; Indonesian has one form). */
export function tp(n: number, one: string, many: string): string {
  const cat = new Intl.PluralRules(locale()).select(n);
  return t(cat === "one" ? one : many, { n: num(n) });
}

export const num = (n: number, o?: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale(), o).format(n);

/** A module-level map of English labels that translates each value when it is read: `PURPOSE[c.purpose]`. */
export function tmap<T extends Record<string, string>>(m: T): T {
  return new Proxy(m, { get: (o, k) => (typeof k === "string" && typeof o[k] === "string" ? t(o[k]) : (o as Record<string | symbol, unknown>)[k]) }) as T;
}
/** A module-level list whose named fields translate when read: `tlist(FILTERS, ["label"])`. */
export function tlist<T extends object>(items: T[], fields: (keyof T)[]): T[] {
  const f = new Set<string | symbol>(fields as (string | symbol)[]);
  return items.map((i) => new Proxy(i, { get: (o, k) => { const v = (o as Record<string | symbol, unknown>)[k]; return f.has(k) && typeof v === "string" ? t(v) : v; } }));
}
export const missingKeys = () => [...missing];

/** Exposed for the browser tests: the language now and the keys shown without a translation. */
if (typeof window !== "undefined") (window as unknown as { __cbI18n: unknown }).__cbI18n = { get lang() { return lang; }, missing: missingKeys };

/** The language this device chose on purpose (picker or ?lang=), or null if it is only following the browser. */
export const savedLang = (): Lang | null => normalise(store.get(KEY));
