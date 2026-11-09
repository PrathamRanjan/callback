/**
 * Safety layer for Callback (SAFETY_ACCESSIBILITY_SPEC §4, §6 Callback row). The people at risk are the customer being
 * called, who cannot tell our agent from a scammer pretending to be the business, and the owner, who could be
 * impersonated by a message that says "change the payout account". So:
 *  - every agent call carries a "verify it's us" code the customer can check on their status page;
 *  - the agent's own lines are scanned before they are spoken: a line that asks for a code, password or card number
 *    is replaced and counted as a breach;
 *  - a refund the agent would make is held when the customer's lines in the transcript ask to send it somewhere else
 *    or carry scam tactics;
 *  - an inbound message claiming to be the owner and asking to change payout or bank details is a hard hold;
 *  - protected mode (per business) makes every agent refund and discount wait for the owner.
 * Rules (A) and the synthetic-data risk model (C) run here; the browser text model (B) only explains messages on /safety.
 * Reads the database only; never imports the PayPal client or the money services.
 */
import { createHmac } from "node:crypto";
import type { Queryable } from "../db.js";
import { getDb } from "../db.js";
import { config } from "../config.js";
import { maxLevel, payeeRules, scanText, TACTIC_WORDS, type Level, type RuleResult, type Tactic } from "./rules.js";
import { riskLevel, riskScore } from "./risk.js";

export interface Assessment {
  level: Level;
  rule: string | null;
  reasons: string[];
  risk: number;
  tactics: Tactic[];
  summary: string;
}

/** A four-digit code per call, derived from the call id and the server secret: spoken by the agent, shown on the customer's page. */
export function verifyCode(callId: string): string {
  const secret = (config as any).sessionSecret ?? (config as any).cookieSecret ?? "callback-demo";
  const h = createHmac("sha256", String(secret)).update(`verify:${callId}`).digest();
  return String(h.readUInt16BE(0) % 10000).padStart(4, "0");
}

/** The agent's own line: true when it asks the customer for something nobody legitimate asks for by phone. */
export function agentLineUnsafe(text: string): { unsafe: boolean; why: string | null } {
  const s = scanText(text);
  if (s.secretsRequested) return { unsafe: true, why: "the line asked for a one-time code, password or card number" };
  if (s.fired.includes("off_platform") || s.fired.includes("gift_cards_crypto")) return { unsafe: true, why: `the line ${TACTIC_WORDS[s.fired.includes("off_platform") ? "off_platform" : "gift_cards_crypto"]}` };
  return { unsafe: false, why: null };
}

const OTHER_ACCOUNT = /\b(refund|send|pay|transfer)\b[^.]{0,60}\b(other|different|new|my (friend|wife|husband|son|daughter|partner)'?s?|another)\s+(account|card|paypal|bank|number)/i;

/** A money move the agent (or the worker) is about to make on a call. */
export async function assessCallMove(move: { action: string; agentScope: string; businessId: string; entityId: string; cents?: number }, q?: Queryable): Promise<Assessment> {
  const db = q ?? (await getDb());
  const callId = move.agentScope.startsWith("agent:") ? move.agentScope.slice(6) : null;
  const call = callId ? (await db.query<any>("SELECT transcript, customer_id FROM calls WHERE id = $1", [callId])).rows[0] : null;
  const transcript: { who: string; text: string }[] = call ? (typeof call.transcript === "string" ? JSON.parse(call.transcript) : call.transcript) ?? [] : [];
  const customerText = transcript.filter((t) => t.who === "customer").map((t) => t.text).join("\n");
  const history = (await db.query<any>("SELECT amount_cents FROM obligations WHERE business_id = $1 AND status IN ('paid','credited','refunded')", [move.businessId])).rows.map((r: any) => Number(r.amount_cents));
  const med = history.length ? history.slice().sort((a: number, b: number) => a - b)[Math.floor(history.length / 2)] : null;
  const res = payeeRules({
    payeeAgeDays: null,
    detailsChangedDaysAgo: null,
    detailsChangeSource: null,
    amountCents: move.cents ?? 1,
    historyMedianCents: move.action === "refund" ? med : null,
    velocity10m: 0,
    velocity24hSumRatio: 1,
    requestChannelUntrusted: false,
    hourLocal: 12,
    text: customerText || null,
  });
  const out = combine(res);
  // The customer's words on the call carry scam tactics only as cautions here (a customer being rude is not a scam), except a refund to a different account, which holds.
  if (out.level === "hold" && out.rule?.startsWith("tactic_")) out.level = "caution";
  if (move.action === "refund" && OTHER_ACCOUNT.test(customerText)) {
    out.level = "hold";
    out.rule = "refund_to_other_account";
    out.reasons.unshift("The customer asked for the refund to go to a different account or card. Refunds go back to the original payment only.");
  }
  const prot = await protectedMode(move.businessId, db);
  if (prot.on && callId && (move.action === "refund" || move.action === "discount") && out.level !== "hold") {
    out.level = "hold";
    out.rule = "protected_agent_money";
    out.reasons.unshift(`Protected mode is on: every ${move.action} the agent offers waits for the owner.`);
  }
  out.summary = out.level === "clear" ? `no scam signals; risk ${(out.risk * 100).toFixed(0)}%` : `${out.level}: ${out.reasons[0]} (risk ${(out.risk * 100).toFixed(0)}%)`;
  return out;
}

function combine(res: RuleResult): Assessment {
  let risk = 0;
  try {
    risk = riskScore(res.features);
  } catch {
    risk = 0;
  }
  const level = maxLevel(res.level, riskLevel(risk));
  const reasons = res.reasons.slice();
  const rule = res.rule ?? (level !== "clear" ? "risk_model" : null);
  if (res.level === "clear" && level !== "clear") reasons.push(`The payment-risk model scores this ${(risk * 100).toFixed(0)}% (synthetic training data; a ranking signal, not a fraud rate).`);
  const summary = level === "clear" ? `no scam signals; risk ${(risk * 100).toFixed(0)}%` : `${level}: ${reasons[0]} (risk ${(risk * 100).toFixed(0)}%)`;
  return { level, rule, reasons, risk, tactics: res.scan.fired, summary };
}

const OWNER_CHANGE = /\b(i'?m|this is|it'?s)\s+(the\s+)?(owner|boss|manager|[A-Z][a-z]+ from the office)\b[\s\S]{0,160}\b(change|update|switch|move)\b[\s\S]{0,80}\b(payout|bank|paypal|account|details|email)/i;

/** An inbound message (Telegram, WhatsApp, SMS, a pasted email). Rules only on the server; the browser adds the text model. */
export function assessMessage(text: string): Assessment & { words: string[]; ownerImpersonation: boolean } {
  const scan = scanText(text);
  const res = payeeRules({ payeeAgeDays: null, detailsChangedDaysAgo: null, detailsChangeSource: null, amountCents: 1, historyMedianCents: null, velocity10m: 0, velocity24hSumRatio: 1, requestChannelUntrusted: true, hourLocal: 12, text });
  const out = combine(res);
  out.reasons = out.reasons.filter((r) => !r.startsWith("The request to pay arrived"));
  const ownerImpersonation = OWNER_CHANGE.test(text) || (scan.fired.includes("changed_details") && /owner|boss|manager/i.test(text));
  if (ownerImpersonation) {
    out.level = "hold";
    out.rule = "owner_impersonation";
    out.reasons.unshift("The message claims to be the owner and asks to change where money goes. Payout details change only in the owner's signed-in settings, never from a message.");
  }
  if (out.reasons.length === 0) out.level = "clear";
  out.summary = out.level === "clear" ? "no scam signals" : `${out.level}: ${out.reasons[0]}`;
  return { ...out, words: scan.fired.map((t) => TACTIC_WORDS[t]), ownerImpersonation };
}

/** Protected mode (§4.5) per business. */
export async function protectedMode(businessId: string, q?: Queryable): Promise<{ on: boolean; contacts: string[] }> {
  const db = q ?? (await getDb());
  const r = (await db.query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [`protected:${businessId}`])).rows[0];
  if (!r) return { on: false, contacts: [] };
  try {
    return JSON.parse(r.value);
  } catch {
    return { on: false, contacts: [] };
  }
}
export async function setProtectedMode(businessId: string, on: boolean, contacts: string[], q?: Queryable) {
  const db = q ?? (await getDb());
  await db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [`protected:${businessId}`, JSON.stringify({ on, contacts: contacts.filter(Boolean).slice(0, 2) })]);
}

/** Holds the safety layer created, newest first. */
export async function safetyHolds(q?: Queryable) {
  const db = q ?? (await getDb());
  return (await db.query<any>("SELECT * FROM approvals WHERE payload->>'safety_rule' IS NOT NULL ORDER BY created_at DESC LIMIT 20")).rows.map((r) => ({ ...r, payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload }));
}
