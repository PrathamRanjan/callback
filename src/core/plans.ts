/**
 * Everything with a number in it is computed here, from the records and the owner's rules; the model only picks an
 * option id. Instalment options, discount steps and callback slots.
 */
import type { Rules } from "../guard/policy.js";
import { localParts, parseHHMM } from "./time.js";

export interface InstalmentOption {
  id: string;
  instalments: number;
  per_cents: number;
  first_cents: number;
  interval_unit: "WEEK" | "MONTH";
  interval_count: number;
  label: string;
}

/** Options the policy allows for this balance: n instalments, each at least the policy's minimum. Pennies land on the first. */
export function instalmentOptions(balanceCents: number, rules: Rules): InstalmentOption[] {
  const out: InstalmentOption[] = [];
  for (let n = 2; n <= rules.max_instalments; n++) {
    const per = Math.floor(balanceCents / n);
    if (per < rules.min_instalment_cents) break;
    const first = balanceCents - per * (n - 1);
    const weekly = n <= 4;
    out.push({ id: `plan${n}`, instalments: n, per_cents: per, first_cents: first, interval_unit: weekly ? "WEEK" : "MONTH", interval_count: weekly ? 2 : 1, label: `${n} ${weekly ? "fortnightly" : "monthly"} payments of $${(per / 100).toFixed(2)}${first !== per ? ` (first $${(first / 100).toFixed(2)})` : ""}` });
  }
  return out;
}

export interface DiscountStep {
  id: string;
  pct: number;
  off_cents: number;
  pay_cents: number;
  label: string;
}

/** Discount steps up to the policy cap (never above the guard's own cap either). The model may pick one; it cannot invent one. */
export function discountSteps(amountCents: number, rules: Rules, guardMaxPct: number): DiscountStep[] {
  const cap = Math.min(rules.max_discount_pct, guardMaxPct);
  const steps = [5, 10, 15, 20, 25].filter((p) => p <= cap);
  return steps.map((pct) => {
    const off = Math.round((amountCents * pct) / 100);
    return { id: `disc${pct}`, pct, off_cents: off, pay_cents: amountCents - off, label: `${pct}% off: pay $${((amountCents - off) / 100).toFixed(2)} today` };
  });
}

export interface CallbackSlot {
  id: string;
  at: string;
  label: string;
}

/** The next calling-window slots in the customer's time zone, from the owner's rules. */
export function callbackSlots(now: Date, tz: string, rules: Rules, count = 4): CallbackSlot[] {
  const out: CallbackSlot[] = [];
  const start = Math.max(8 * 60, parseHHMM(rules.hours.start));
  const end = Math.min(21 * 60, parseHHMM(rules.hours.end));
  for (let d = 0; d < 7 && out.length < count; d++) {
    const base = new Date(now.getTime() + d * 86400_000);
    const p = localParts(base, tz);
    if (!rules.days.includes(p.weekday)) continue;
    for (const m of [start + 60, Math.floor((start + end) / 2), end - 90]) {
      if (out.length >= count) break;
      const cur = p.hour * 60 + p.minute;
      if (d === 0 && m <= cur + 60) continue;
      const at = new Date(base.getTime() + (m - cur) * 60_000);
      out.push({ id: `slot${out.length + 1}`, at: at.toISOString(), label: new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit" }).format(at) });
    }
  }
  return out;
}
