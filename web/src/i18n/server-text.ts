/**
 * Server reasons arrive as English sentences built by code (the planner, consent rules, the money gate). Nothing in the
 * app's logic reads these words back: decisions use codes (status, outcome, gate). So the words can be translated for
 * display here, phrase by phrase. A phrase this list doesn't know is shown as the server wrote it, in English.
 */
import { currentLang, t } from "./index";
import { money } from "@/lib/format";

const usd = (s: string) => money(Math.round(Number(s.replace(/,/g, "")) * 100));
type Rule = [RegExp, (m: RegExpExecArray) => string];

const RULES: Rule[] = [
  [/^deposit of \$([\d,.]+) unpaid, appointment in (\d+) h$/, (m) => t("deposit of {amount} unpaid, appointment in {h} h", { amount: usd(m[1]), h: m[2] })],
  [/^\$([\d,.]+) overdue by (\d+) days$/, (m) => t("{amount} overdue by {n} days", { amount: usd(m[1]), n: m[2] })],
  [/^class cancelled, \$([\d,.]+) paid: customer must choose credit or refund$/, (m) => t("class cancelled, {amount} paid: customer must choose credit or refund", { amount: usd(m[1]) })],
  [/^kill switch on calls: (.*)$/, (m) => t("kill switch on calls: {0}", [m[1]])],
  [/^customer is on the do-not-call list$/, () => t("customer is on the do-not-call list")],
  [/^no recorded consent to be called$/, () => t("no recorded consent to be called")],
  [/^consent revoked (\S+)$/, (m) => t("consent revoked {0}", [m[1]])],
  [/^the policy does not allow (.+) calls$/, (m) => t("the policy does not allow {0} calls", [m[1]])],
  [/^not a calling day \((\w+) in (.+)\)$/, (m) => t("not a calling day ({day} in {tz})", { day: m[1], tz: m[2] })],
  [/^outside calling hours: (\d\d:\d\d) in (.+), window (\S+)–(\S+) \(statutory floor 08:00–21:00\)$/, (m) => t("outside calling hours: {time} in {tz}, window {start}–{end} (statutory floor 08:00–21:00)", { time: m[1], tz: m[2], start: m[3], end: m[4] })],
  [/^already (\d+) attempts? today \(limit (\d+)\)$/, (m) => t("already {n} attempts today (limit {max})", { n: m[1], max: m[2] })],
  [/^last attempt under (\d+) h ago$/, (m) => t("last attempt under {0} h ago", [m[1]])],
  [/^skipped by staff$/, () => t("skipped by staff")],
  [/^stopped by the owner$/, () => t("stopped by the owner")],
  [/^over your \$([\d,.]+) limit for a (\w+) without asking$/, (m) => t("over your {amount} limit for a {action} without asking", { amount: usd(m[1]), action: t(m[2]) })],
  [/^the customer disputes this item; the owner reviews it first$/, () => t("the customer disputes this item; the owner reviews it first")],
  [/^Paying 3 sample items from the saved sandbox wallet…$/, () => t("Paying 3 sample items from the saved sandbox wallet…")],
  [/^The saved demo wallet is not set up, so the seed's sample payments were not made\.$/, () => t("The saved demo wallet is not set up, so the seed's sample payments were not made.")],
  [/^(\d+) of (\d+) payments confirmed by PayPal so far…$/, (m) => t("{done} of {n} payments confirmed by PayPal so far…", { done: m[1], n: m[2] })],
  [/^(\d+) of (\d+) payments confirmed by PayPal$/, (m) => t("{done} of {n} payments confirmed by PayPal", { done: m[1], n: m[2] })],
  [/^not made: (.*)$/, (m) => t("not made: {0}", [m[1]])],
  [/^not needed: nothing left to collect$/, () => t("not needed: nothing left to collect")],
  [/^not needed: money is held on it and charged if they attend$/, () => t("not needed: money is held on it and charged if they attend")],
  [/^not needed now: being paid from the saved demo wallet$/, () => t("not needed now: being paid from the saved demo wallet")],
  [/^transcript decision: (\w+)$/, (m) => t("transcript decision: {0}", [m[1].replace(/_/g, " ")])],
];

function one(s: string): string {
  const x = s.trim();
  for (const [re, f] of RULES) {
    const m = re.exec(x);
    if (m) return f(m);
  }
  return x;
}

/** Translates a server reason such as "deposit of $40.00 unpaid, appointment in 20 h; not called: no recorded consent to be called". */
export function serverText(s: string | null | undefined): string {
  if (!s) return "";
  if (currentLang() === "en") return s;
  const [head, ...rest] = s.split("; not called: ");
  const parts = [head.split("; ").map(one).join("; ")];
  if (rest.length) parts.push(t("not called: {0}", [rest.join("; not called: ").split("; ").map(one).join("; ")]));
  return parts.join("; ");
}

/** The phrases above, for the key check (scripts/i18n-check.mjs reads this list). */
export const SERVER_KEYS = [
  "deposit of {amount} unpaid, appointment in {h} h", "{amount} overdue by {n} days", "class cancelled, {amount} paid: customer must choose credit or refund",
  "kill switch on calls: {0}", "customer is on the do-not-call list", "no recorded consent to be called", "consent revoked {0}", "the policy does not allow {0} calls",
  "not a calling day ({day} in {tz})", "outside calling hours: {time} in {tz}, window {start}–{end} (statutory floor 08:00–21:00)", "already {n} attempts today (limit {max})",
  "last attempt under {0} h ago", "skipped by staff", "stopped by the owner", "over your {amount} limit for a {action} without asking",
  "the customer disputes this item; the owner reviews it first", "transcript decision: {0}", "not called: {0}", "Paying 3 sample items from the saved sandbox wallet…", "The saved demo wallet is not set up, so the seed's sample payments were not made.",
  "{done} of {n} payments confirmed by PayPal so far…", "{done} of {n} payments confirmed by PayPal", "not made: {0}", "not needed: nothing left to collect", "not needed now: being paid from the saved demo wallet", "not needed: money is held on it and charged if they attend", "charge", "invoice", "plan", "discount", "refund", "hold",
];
