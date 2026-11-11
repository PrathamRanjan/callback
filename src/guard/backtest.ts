/**
 * Policy backtest and earned autonomy (roadmap B.6, Callback). Replays 90 days of seeded calls a person made by hand
 * (deposits confirmed, invoices chased, classes cancelled) through a candidate policy: how many Callback would have
 * made on its own (run), how many would have waited for the owner (wait), how many it would have refused to make at
 * all (deny: outside hours or without consent), the money collected automatically versus held, and the hours of
 * phone time saved. Earned autonomy suggests limits from the owner's own approvals and never past anything declined.
 */
import type { Queryable } from "../db.js";
import { getDb } from "../db.js";
import { newId } from "../lib/ids.js";
import { guardSettings, saveGuardSettings, type GuardSettings } from "./dryrun.js";
import type { Rules } from "./policy.js";

export interface HistoryRow {
  id: string;
  business_id: string;
  at: Date;
  purpose: "confirm_deposit" | "chase_invoice" | "cancel_class";
  customer: string;
  amount_cents: number;
  outcome: "paid" | "plan" | "callback" | "refused" | "no_answer" | "refunded" | "credited";
  discount_pct: number;
  instalments: number;
  local_hour: number;
  consent: boolean;
  owner_would_approve: boolean;
  by_hand_minutes: number;
}

/** Deterministic 90-day sample: 48 calls with who, how much, when (local hour), and what happened. */
export async function seedHistory(businessId: string, q?: Queryable) {
  const db = q ?? (await getDb());
  const n = Number((await db.query<{ c: string }>("SELECT count(*) AS c FROM call_history WHERE business_id = $1", [businessId])).rows[0].c);
  if (n) return n;
  const rows: [HistoryRow["purpose"], string, number, HistoryRow["outcome"], number, number, number, boolean, boolean][] = [
    // purpose, customer, cents, outcome, discount%, instalments, local hour, consent, owner would approve
    ["confirm_deposit", "Priya N.", 6000, "paid", 0, 1, 10, true, true],
    ["chase_invoice", "Harbour Dental", 42000, "plan", 0, 3, 14, true, true],
    ["cancel_class", "Tom R.", 3500, "credited", 0, 1, 11, true, true],
    ["chase_invoice", "Lena K.", 18000, "paid", 10, 1, 16, true, true],
    ["confirm_deposit", "Marcus O.", 9000, "callback", 0, 1, 18, true, true],
    ["chase_invoice", "Birch & Co", 64000, "plan", 0, 4, 15, true, false],
    ["chase_invoice", "Sam W.", 22000, "paid", 25, 1, 12, true, false],
    ["confirm_deposit", "Ana P.", 15000, "paid", 0, 1, 20, true, true],
    ["cancel_class", "Jess M.", 3500, "refunded", 0, 1, 9, true, true],
    ["chase_invoice", "Oak Street Bakery", 31000, "no_answer", 0, 1, 13, true, true],
    ["confirm_deposit", "Dev S.", 6000, "refused", 0, 1, 7, true, true],
    ["chase_invoice", "Noor A.", 12500, "paid", 5, 1, 17, false, false],
  ];
  const base = Date.now() - 90 * 86400_000;
  let i = 0;
  for (let day = 1; day < 90; day += 2) {
    const r = rows[i % rows.length];
    const scale = 1 + ((i * 7) % 5) * 0.15;
    const minutes = r[0] === "chase_invoice" ? 11 : r[0] === "confirm_deposit" ? 6 : 8;
    await db.query(
      "INSERT INTO call_history (id, business_id, at, purpose, customer, amount_cents, outcome, discount_pct, instalments, local_hour, consent, owner_would_approve, by_hand_minutes, is_sample) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true)",
      [newId("hist"), businessId, new Date(base + day * 86400_000 + r[6] * 3600_000), r[0], r[1], Math.round(r[2] * scale), r[3], r[4], r[5], r[6], r[7], r[8], minutes],
    );
    i++;
  }
  return i;
}

export async function history(businessId: string, q?: Queryable): Promise<HistoryRow[]> {
  const db = q ?? (await getDb());
  return (await db.query<HistoryRow>("SELECT * FROM call_history WHERE business_id = $1 ORDER BY at", [businessId])).rows.map((r) => ({ ...r, amount_cents: Number(r.amount_cents), discount_pct: Number(r.discount_pct), instalments: Number(r.instalments), local_hour: Number(r.local_hour), by_hand_minutes: Number(r.by_hand_minutes) }));
}

export interface BacktestResult {
  cases: number;
  run: number;
  wait: number;
  deny: number;
  collected_auto_cents: number;
  held_cents: number;
  minutes_saved: number;
  minutes_still_by_hand: number;
  would_have_declined: number;
  breaches_prevented: number;
  rows: { id: string; at: Date; purpose: string; customer: string; amount_cents: number; outcome: string; decision: "run" | "wait" | "deny"; why: string }[];
}

const toMin = (s: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};

/** Replay the sample calls through candidate rules and limits. */
export function backtest(rows: HistoryRow[], rules: Rules, limits: GuardSettings): BacktestResult {
  const out: BacktestResult = { cases: rows.length, run: 0, wait: 0, deny: 0, collected_auto_cents: 0, held_cents: 0, minutes_saved: 0, minutes_still_by_hand: 0, would_have_declined: 0, breaches_prevented: 0, rows: [] };
  const d = (c: number) => (c / 100).toFixed(2);
  const start = Math.max(8 * 60, toMin(rules.hours.start));
  const end = Math.min(21 * 60, toMin(rules.hours.end));
  for (const r of rows) {
    let decision: "run" | "wait" | "deny" = "run";
    let why = "within the policy";
    const hourMin = r.local_hour * 60;
    if (!r.consent) {
      decision = "deny";
      why = "no recorded consent: the call is never made";
      out.breaches_prevented++;
    } else if (hourMin < start || hourMin >= end) {
      decision = "deny";
      why = `${String(r.local_hour).padStart(2, "0")}:00 is outside ${rules.hours.start}–${rules.hours.end}: the call waits for the window`;
      out.breaches_prevented++;
    } else if (!rules.purposes.includes(r.purpose)) {
      decision = "deny";
      why = `${r.purpose.replace(/_/g, " ")} calls are not in the policy`;
    } else if (r.discount_pct > Math.min(rules.max_discount_pct, limits.auto_discount_max_pct)) {
      decision = "wait";
      why = `${r.discount_pct}% discount is above the ${Math.min(rules.max_discount_pct, limits.auto_discount_max_pct)}% cap: the agent offers the cap and the rest waits for you`;
    } else if (r.instalments > rules.max_instalments) {
      decision = "wait";
      why = `${r.instalments} instalments is above the limit of ${rules.max_instalments}`;
    } else if ((r.outcome === "refunded" ? r.amount_cents > Math.min(limits.auto_refund_max_cents, rules.auto_refund_max_cents) : r.amount_cents > Math.min(limits.auto_charge_max_cents, rules.auto_charge_max_cents))) {
      decision = "wait";
      why = `${d(r.amount_cents)} is above the ${d(r.outcome === "refunded" ? Math.min(limits.auto_refund_max_cents, rules.auto_refund_max_cents) : Math.min(limits.auto_charge_max_cents, rules.auto_charge_max_cents))} limit`;
    }
    const collected = ["paid", "plan"].includes(r.outcome) ? Math.round(r.amount_cents * (1 - r.discount_pct / 100)) : 0;
    if (decision === "run") {
      out.run++;
      out.collected_auto_cents += collected;
      out.minutes_saved += r.by_hand_minutes;
      if (!r.owner_would_approve) out.would_have_declined++;
    } else if (decision === "wait") {
      out.wait++;
      out.held_cents += collected;
      out.minutes_still_by_hand += r.by_hand_minutes;
    } else out.deny++;
    out.rows.push({ id: r.id, at: r.at, purpose: r.purpose, customer: r.customer, amount_cents: r.amount_cents, outcome: r.outcome, decision, why });
  }
  return out;
}

export interface AutonomySuggestion {
  current: GuardSettings;
  suggested: GuardSettings;
  evidence: string[];
  approvals: number;
  declines: number;
}

/** Earned autonomy: from the owner's decided approvals, suggest limits that cover what they approved, never what they declined. */
export async function suggestAutonomy(businessId: string, q?: Queryable): Promise<AutonomySuggestion> {
  const db = q ?? (await getDb());
  const current = await guardSettings(businessId, db);
  const decided = (await db.query<any>("SELECT action, status, payload FROM approvals WHERE status IN ('approved','declined') ORDER BY decided_at DESC LIMIT 200")).rows
    .map((r) => ({ ...r, payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload }))
    .filter((r) => !r.payload.businessId || r.payload.businessId === businessId);
  const evidence: string[] = [];
  const suggested = { ...current };
  const groups: Record<string, { pick: (a: any) => boolean; key: keyof GuardSettings; value: (a: any) => number }> = {
    charge: { pick: (a) => ["charge", "invoice", "plan", "hold"].includes(a.action), key: "auto_charge_max_cents", value: (a) => Number(a.payload.cents ?? 0) },
    refund: { pick: (a) => a.action === "refund", key: "auto_refund_max_cents", value: (a) => Number(a.payload.cents ?? 0) },
    discount: { pick: (a) => a.action === "discount", key: "auto_discount_max_pct", value: (a) => Number(a.payload.discountPct ?? 0) },
  };
  for (const [name, g] of Object.entries(groups)) {
    const rows = decided.filter(g.pick);
    const approved = rows.filter((a) => a.status === "approved").map(g.value);
    const declined = rows.filter((a) => a.status === "declined").map(g.value);
    if (approved.length >= 3) {
      const ceiling = declined.length ? Math.min(...declined) - 1 : Infinity;
      const want = Math.min(Math.max(...approved), ceiling);
      if (want > current[g.key]) {
        suggested[g.key] = want;
        const show = (v: number) => (name === "discount" ? `${v}%` : (v / 100).toFixed(2));
        evidence.push(`You approved ${approved.length} ${name}s up to ${show(Math.max(...approved))}${declined.length ? ` and declined from ${show(Math.min(...declined))}` : ""}: raise the ${name} limit to ${show(want)}.`);
      }
    } else if (rows.length) evidence.push(`${approved.length} ${name} approval${approved.length === 1 ? "" : "s"} so far; three are needed before Callback suggests a change.`);
  }
  if (!evidence.length) evidence.push("No decided approvals yet. Limits stay where they are until you have approved or declined a few holds.");
  return { current, suggested, evidence, approvals: decided.filter((a) => a.status === "approved").length, declines: decided.filter((a) => a.status === "declined").length };
}

export async function adoptSuggestions(businessId: string, by: string) {
  const s = await suggestAutonomy(businessId);
  return saveGuardSettings(businessId, s.suggested, by);
}
