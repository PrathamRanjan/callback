/**
 * Call policy (roadmap B.6 / E.4): the owner writes who may be called, when, and how far the agent may go, in plain
 * words. `compileLocal` turns it into declarative rules with regexes; with a model key `compilePolicy` asks the model
 * for the same shape (quotes only: every number it returns must appear in the owner's text or it is dropped) and the
 * parts that could not be expressed are shown back. Rules are clamped so no policy can exceed the statutory window
 * or the guard's own caps.
 */
import { z } from "zod";
import { hasOpenAI, structured } from "../ai/provider.js";
import { spanExists } from "../ai/grounding.js";
import type { Queryable } from "../db.js";
import { getDb } from "../db.js";
import { newId } from "../lib/ids.js";
import { appendAudit } from "./audit.js";

export const PURPOSES = ["confirm_deposit", "chase_invoice", "cancel_class"] as const;
export type Purpose = (typeof PURPOSES)[number];

export const RulesSchema = z.object({
  purposes: z.array(z.enum(PURPOSES)),
  hours: z.object({ start: z.string(), end: z.string() }),
  /** 0 = Sunday … 6 = Saturday */
  days: z.array(z.number().int().min(0).max(6)),
  max_discount_pct: z.number().int().min(0).max(50),
  max_instalments: z.number().int().min(1).max(12),
  min_instalment_cents: z.number().int().min(500),
  max_attempts_per_day: z.number().int().min(1).max(3),
  cooldown_hours: z.number().int().min(1).max(72),
  /** The agent may send a pay link or create an invoice up to this without the owner. */
  auto_charge_max_cents: z.number().int().min(0),
  /** A class-cancellation refund the agent may make without the owner. */
  auto_refund_max_cents: z.number().int().min(0),
  require_consent: z.literal(true),
});
export type Rules = z.infer<typeof RulesSchema>;

export const DEFAULT_RULES: Rules = {
  purposes: ["confirm_deposit", "chase_invoice", "cancel_class"],
  hours: { start: "09:00", end: "19:00" },
  days: [1, 2, 3, 4, 5],
  max_discount_pct: 10,
  max_instalments: 3,
  min_instalment_cents: 2500,
  max_attempts_per_day: 1,
  cooldown_hours: 24,
  auto_charge_max_cents: 30000,
  auto_refund_max_cents: 10000,
  require_consent: true,
};

export interface Compiled {
  rules: Rules;
  unexpressed: string[];
  refused: string[];
  source: "rules" | "model";
}

const WORDNUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
const num = (s: string) => (WORDNUM[s.toLowerCase()] ?? Number(s));
const toHHMM = (h: string, m: string | undefined, ap: string | undefined) => {
  let hour = Number(h);
  if (ap?.toLowerCase().startsWith("p") && hour < 12) hour += 12;
  if (ap?.toLowerCase().startsWith("a") && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${m ?? "00"}`;
};

/** Things a policy may not ask for: the agent refuses them with the reason. */
const FORBIDDEN: [RegExp, string][] = [
  [/(call|ring|phone).{0,40}(anyone|everyone|all customers|whether or not|without consent|even if they (opted|asked))/i, "Calling without recorded consent is never allowed."],
  [/(before|from)\s+(5|6|7)\s*(am|a\.m\.)|after\s+(9|10|11)\s*(pm|p\.m\.)|(any time|anytime|24.?7|round the clock)/i, "Calls outside 08:00–21:00 local time are never allowed (statutory floor)."],
  [/(threat|threaten|pretend|impersonat|say (it's|it is) (the|a) (court|lawyer|police|bank))/i, "The agent may not threaten or impersonate."],
  [/(take|read|ask for).{0,20}(card|credit card) (number|details)/i, "The agent never takes card details; payment is a PayPal link."],
];

export function compileLocal(text: string): Compiled {
  const t = text.replace(/\s+/g, " ").trim();
  const rules: Rules = JSON.parse(JSON.stringify(DEFAULT_RULES));
  const unexpressed: string[] = [];
  const refused = FORBIDDEN.filter(([re]) => re.test(t)).map(([, why]) => why);

  // Purposes
  const wants: Purpose[] = [];
  if (/deposit|appointment|confirm/i.test(t)) wants.push("confirm_deposit");
  if (/invoice|overdue|chase|owe|balance|collect/i.test(t)) wants.push("chase_invoice");
  if (/cancel|class|session|reschedul/i.test(t)) wants.push("cancel_class");
  if (wants.length) rules.purposes = wants;
  if (/\b(never|don'?t|do not) (call|chase|ring).{0,30}(overdue|invoice)/i.test(t)) rules.purposes = rules.purposes.filter((p) => p !== "chase_invoice");

  // Hours: "between 9am and 6pm", "9:00 to 18:00", "from 10 to 5pm"
  const hrs = /(?:between|from)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*(?:to|and|-|–|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i.exec(t);
  if (hrs) {
    const sAp = hrs[3] ?? (hrs[6] && Number(hrs[1]) < 12 && Number(hrs[1]) >= 7 ? "am" : undefined);
    rules.hours = { start: toHHMM(hrs[1], hrs[2], sAp), end: toHHMM(hrs[4], hrs[5], hrs[6]) };
  }
  if (/weekends? (too|as well|included)|seven days|every day|any day/i.test(t)) rules.days = [0, 1, 2, 3, 4, 5, 6];
  else if (/saturday/i.test(t) && !/not on saturday|no saturday/i.test(t)) rules.days = [1, 2, 3, 4, 5, 6];
  if (/weekdays only|monday to friday|mon-fri|no weekends/i.test(t)) rules.days = [1, 2, 3, 4, 5];

  // Discount cap
  const disc = /(?:up to|max(?:imum)?|at most|no more than)\s*(\d{1,2})\s*(?:%|percent|per cent)\s*(?:off|discount)?|(\d{1,2})\s*(?:%|percent)\s*(?:off|discount)\s*(?:max|at most|tops)?/i.exec(t);
  if (disc) rules.max_discount_pct = Math.min(50, Number(disc[1] ?? disc[2]));
  if (/no discounts?|never discount|zero discount/i.test(t)) rules.max_discount_pct = 0;

  // Instalments
  const inst = /(?:up to|max(?:imum)?|at most|no more than)?\s*(\d{1,2}|two|three|four|five|six)\s*(?:instal?lments?|payments?|parts?)/i.exec(t);
  if (inst) rules.max_instalments = Math.max(1, Math.min(12, num(inst[1])));
  if (/no (instal?lments?|payment plans?)/i.test(t)) rules.max_instalments = 1;
  const minInst = /(?:at least|minimum|min\.?)\s*\$?\s*(\d{2,4})\s*(?:per|an?|each)?\s*(?:instal?lment|payment)/i.exec(t);
  if (minInst) rules.min_instalment_cents = Math.max(500, Number(minInst[1]) * 100);

  // Attempts and cooldown
  const att = /(once|twice|one|two|three|\d)\s*(?:call|attempt|time)s?\s*(?:a|per)\s*day/i.exec(t);
  if (att) rules.max_attempts_per_day = Math.max(1, Math.min(3, att[1].toLowerCase() === "once" ? 1 : att[1].toLowerCase() === "twice" ? 2 : num(att[1])));
  const cool = /(?:wait|leave|at least)\s*(\d{1,2})\s*(hours?|days?)\s*(?:between|before)/i.exec(t);
  if (cool) rules.cooldown_hours = Math.min(72, Number(cool[1]) * (cool[2].startsWith("day") ? 24 : 1));

  // Money limits the agent may move alone
  const charge = /(?:links?|invoices?|charges?|collect)\s*(?:up to|under|below|max(?:imum)?)\s*\$?\s*(\d{2,5})|\$?\s*(\d{2,5})\s*(?:or less|and under|max)\s*(?:without|before) (?:asking|me)/i.exec(t);
  if (charge) rules.auto_charge_max_cents = Number(charge[1] ?? charge[2]) * 100;
  const ref = /refunds?\s*(?:up to|under|below|max(?:imum)?)\s*\$?\s*(\d{2,5})/i.exec(t);
  if (ref) rules.auto_refund_max_cents = Number(ref[1]) * 100;

  // Things we understood as a request but cannot express
  for (const [re, what] of [
    [/(tone|friendly|polite|warm|gentle)/i, "Tone words are passed to the agent's script but are not a rule the gate can enforce."],
    [/(spanish|mandarin|language)/i, "Language preference is noted; the voice model's language is not yet a rule."],
    [/(vip|regular|loyal) customers?/i, "Customer tiers are not modelled; the same limits apply to everyone."],
  ] as [RegExp, string][])
    if (re.test(t)) unexpressed.push(what);

  return { rules: clampRules(rules), unexpressed, refused, source: "rules" };
}

export function clampRules(r: Rules): Rules {
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)));
  const toMin = (s: string) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  };
  let s = toMin(r.hours.start);
  let e = toMin(r.hours.end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) {
    s = 9 * 60;
    e = 19 * 60;
  }
  s = Math.max(8 * 60, s);
  e = Math.min(21 * 60, e);
  const hh = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return {
    purposes: [...new Set(r.purposes)].filter((p) => (PURPOSES as readonly string[]).includes(p)) as Purpose[],
    hours: { start: hh(s), end: hh(e) },
    days: [...new Set(r.days)].filter((d) => d >= 0 && d <= 6).sort(),
    max_discount_pct: clamp(r.max_discount_pct, 0, 50),
    max_instalments: clamp(r.max_instalments, 1, 12),
    min_instalment_cents: clamp(r.min_instalment_cents, 500, 1_000_000),
    max_attempts_per_day: clamp(r.max_attempts_per_day, 1, 3),
    cooldown_hours: clamp(r.cooldown_hours, 1, 72),
    auto_charge_max_cents: clamp(r.auto_charge_max_cents, 0, 5_000_000),
    auto_refund_max_cents: clamp(r.auto_refund_max_cents, 0, 5_000_000),
    require_consent: true,
  };
}

/** Model-assisted compile: the model may only return quotes from the owner's text for every number; code converts. */
export async function compilePolicy(text: string, runId?: string | null): Promise<Compiled> {
  const local = compileLocal(text);
  if (!hasOpenAI()) return local;
  try {
    const r = await structured<any>({
      purpose: "policy",
      tier: "read",
      runId: runId ?? null,
      system: "You read a small business owner's call policy. Return which call purposes they allow, and for each limit the exact quote from their text that states it (or null). Never compute or convert numbers; code does that from your quotes. List anything they asked for that is not one of these limits under unexpressed.",
      parts: [{ type: "text", text }],
      schemaName: "call_policy",
      schema: {
        type: "object",
        properties: {
          purposes: { type: "array", items: { type: "string", enum: [...PURPOSES] } },
          hours_quote: { type: ["string", "null"] },
          discount_quote: { type: ["string", "null"] },
          instalments_quote: { type: ["string", "null"] },
          amount_quote: { type: ["string", "null"] },
          unexpressed: { type: "array", items: { type: "string" } },
        },
      },
    });
    const o = r.output;
    const rules = { ...local.rules };
    if (Array.isArray(o.purposes) && o.purposes.length) rules.purposes = o.purposes;
    const unexpressed = [...local.unexpressed];
    for (const q of ["hours_quote", "discount_quote", "instalments_quote", "amount_quote"]) if (o[q] && !spanExists(text, o[q])) unexpressed.push(`The model quoted "${String(o[q]).slice(0, 60)}" which is not in your text; ignored.`);
    for (const u of o.unexpressed ?? []) if (typeof u === "string") unexpressed.push(u);
    return { rules: clampRules(rules), unexpressed: [...new Set(unexpressed)], refused: local.refused, source: "model" };
  } catch {
    return local;
  }
}

export async function activePolicy(businessId: string, q?: Queryable): Promise<{ id: string | null; text: string; rules: Rules }> {
  const db = q ?? (await getDb());
  const r = (await db.query<any>("SELECT id, text, rules FROM policies WHERE business_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1", [businessId])).rows[0];
  if (!r) return { id: null, text: "", rules: DEFAULT_RULES };
  const rules = typeof r.rules === "string" ? JSON.parse(r.rules) : r.rules;
  return { id: r.id, text: r.text, rules: clampRules({ ...DEFAULT_RULES, ...rules }) };
}

export async function savePolicy(businessId: string, text: string, compiled: Compiled, activate: boolean, by: string, q?: Queryable): Promise<string> {
  const db = q ?? (await getDb());
  const id = newId("pol");
  if (activate) await db.query("UPDATE policies SET status = 'retired' WHERE business_id = $1 AND status = 'active'", [businessId]);
  await db.query("INSERT INTO policies (id, business_id, text, rules, unexpressed, source, status) VALUES ($1,$2,$3,$4,$5,$6,$7)", [id, businessId, text, JSON.stringify(compiled.rules), JSON.stringify(compiled.unexpressed), compiled.source, activate ? "active" : "draft"]);
  await appendAudit(activate ? "policy.activated" : "policy.drafted", "policy", id, { by, rules: compiled.rules, refused: compiled.refused }, db);
  return id;
}

export async function listPolicies(businessId: string) {
  const db = await getDb();
  return (await db.query<any>("SELECT * FROM policies WHERE business_id = $1 ORDER BY created_at DESC LIMIT 20", [businessId])).rows.map((r) => ({ ...r, rules: typeof r.rules === "string" ? JSON.parse(r.rules) : r.rules, unexpressed: typeof r.unexpressed === "string" ? JSON.parse(r.unexpressed) : r.unexpressed }));
}
