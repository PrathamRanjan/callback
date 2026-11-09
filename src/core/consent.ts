/**
 * Consent and calling hours, enforced in code (roadmap E.4). A customer is callable only when all hold:
 *  - recorded consent to be called about their account, not revoked, and not on the do-not-call list;
 *  - the owner's policy allows this purpose;
 *  - it is inside the owner's calling hours AND inside the statutory window (08:00 to 21:00 local to the customer,
 *    the TCPA-style floor that the owner cannot widen), on an allowed weekday;
 *  - fewer than the policy's attempts today, and no call within the cooldown.
 * The model never sees these checks; the planner and startCall refuse before any dialling.
 */
import { localParts, parseHHMM } from "./time.js";
import type { Rules } from "../guard/policy.js";

export interface Consent {
  granted_at: string;
  source: string;
  text: string;
  revoked_at?: string | null;
}

export interface CallableCustomer {
  id: string;
  tz: string;
  consent: Consent | null;
  dnc: boolean;
}

export interface CallHistory {
  attempts_today: number;
  last_attempt_at: Date | null;
}

export const STATUTORY_START = 8 * 60;
export const STATUTORY_END = 21 * 60;

export interface Verdict {
  ok: boolean;
  consent_ok: boolean;
  hours_ok: boolean;
  reasons: string[];
  /** When hours are the problem: the next local time a call is allowed, as an ISO string, or null. */
  next_window: string | null;
}

export function mayCall(c: CallableCustomer, purpose: Rules["purposes"][number], rules: Rules, now: Date, hist: CallHistory): Verdict {
  const reasons: string[] = [];
  let consent_ok = true;
  if (c.dnc) {
    consent_ok = false;
    reasons.push("customer is on the do-not-call list");
  }
  if (!c.consent) {
    consent_ok = false;
    reasons.push("no recorded consent to be called");
  } else if (c.consent.revoked_at) {
    consent_ok = false;
    reasons.push(`consent revoked ${c.consent.revoked_at.slice(0, 10)}`);
  }
  if (!rules.purposes.includes(purpose)) reasons.push(`the policy does not allow ${purpose.replace(/_/g, " ")} calls`);

  const lp = localParts(now, c.tz);
  const minutes = lp.hour * 60 + lp.minute;
  const start = Math.max(STATUTORY_START, parseHHMM(rules.hours.start));
  const end = Math.min(STATUTORY_END, parseHHMM(rules.hours.end));
  let hours_ok = true;
  if (!rules.days.includes(lp.weekday)) {
    hours_ok = false;
    reasons.push(`not a calling day (${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][lp.weekday]} in ${c.tz})`);
  }
  if (minutes < start || minutes >= end) {
    hours_ok = false;
    reasons.push(`outside calling hours: ${String(lp.hour).padStart(2, "0")}:${String(lp.minute).padStart(2, "0")} in ${c.tz}, window ${rules.hours.start}–${rules.hours.end} (statutory floor 08:00–21:00)`);
  }
  if (hist.attempts_today >= rules.max_attempts_per_day) reasons.push(`already ${hist.attempts_today} attempt${hist.attempts_today === 1 ? "" : "s"} today (limit ${rules.max_attempts_per_day})`);
  if (hist.last_attempt_at && now.getTime() - hist.last_attempt_at.getTime() < rules.cooldown_hours * 3600_000) reasons.push(`last attempt under ${rules.cooldown_hours} h ago`);

  let next_window: string | null = null;
  if (!hours_ok) {
    for (let d = 0; d < 8 && !next_window; d++) {
      const day = new Date(now.getTime() + d * 86400_000);
      const p = localParts(day, c.tz);
      if (!rules.days.includes(p.weekday)) continue;
      const m = d === 0 ? minutes : -1;
      if (m < start) {
        const diffMin = d === 0 ? start - minutes : start - m + 0;
        next_window = new Date(now.getTime() + (d === 0 ? diffMin : (24 * 60 - minutes + start + (d - 1) * 24 * 60)) * 60_000).toISOString();
      }
    }
  }
  return { ok: reasons.length === 0, consent_ok, hours_ok, reasons, next_window };
}
