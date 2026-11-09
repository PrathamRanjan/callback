/**
 * Dry-run money gate (roadmap B.6). Every move the agent proposes on a call (a pay link, an invoice, an instalment
 * plan, a discount, a class refund) passes through `gate` before the PayPal client is called. It checks, in order:
 * kill switches, integer money, provenance of the amount, the owner's policy (discount cap, instalment limits),
 * live PayPal state, and the autonomy limits. The decision is written to the trace before PayPal sees anything.
 *
 * The owner's own click is their approval and is never held. A customer's own tap on a pay link is theirs.
 */
import { createHash } from "node:crypto";
import { config } from "../config.js";
import type { Queryable } from "../db.js";
import { getDb } from "../db.js";
import { newId } from "../lib/ids.js";
import { paypal, paypalConfigured } from "../paypal/index.js";
import type { Run } from "../trace.js";
import { appendAudit } from "./audit.js";
import { isKilled } from "./kill.js";
import { activePolicy } from "./policy.js";
import { moneyArgumentOk } from "./provenance.js";
import { notifyParty } from "../channels/index.js";

export type MoneyAction = "charge" | "invoice" | "plan" | "discount" | "refund";

export interface MoneyMove {
  action: MoneyAction;
  /** Who is acting: "agent:<call id>", "owner", "worker", "customer", "system". */
  agentScope: string;
  entity: "obligation" | "call";
  entityId: string;
  businessId: string;
  cents?: number;
  /** Amounts code derived (the obligation's balance, a policy-computed option); the only values an amount may equal. */
  trustedCents?: number[];
  /** For a discount: the percentage code computed, checked against the policy cap. */
  discountPct?: number;
  /** For a plan: the instalment count, checked against the policy. */
  instalments?: number;
  paypal?: { orderId?: string | null; captureId?: string | null } | null;
  /** A hand click by the owner or the customer. Holds apply to the agent and the worker, not to a person's own click. */
  personInitiated?: boolean;
  note?: string;
}

export interface GuardSettings {
  auto_charge_max_cents: number;
  auto_refund_max_cents: number;
  auto_discount_max_pct: number;
}
export const DEFAULT_GUARD: GuardSettings = { auto_charge_max_cents: 30000, auto_refund_max_cents: 10000, auto_discount_max_pct: 10 };

export async function guardSettings(businessId: string, q?: Queryable): Promise<GuardSettings> {
  const db = q ?? (await getDb());
  const r = (await db.query<GuardSettings>("SELECT auto_charge_max_cents, auto_refund_max_cents, auto_discount_max_pct FROM guard_settings WHERE id = $1", [businessId])).rows[0];
  return r ? { auto_charge_max_cents: Number(r.auto_charge_max_cents), auto_refund_max_cents: Number(r.auto_refund_max_cents), auto_discount_max_pct: Number(r.auto_discount_max_pct) } : { ...DEFAULT_GUARD };
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(n) || 0)));

export async function saveGuardSettings(businessId: string, s: Partial<GuardSettings>, by: string) {
  const db = await getDb();
  const cur = await guardSettings(businessId, db);
  const next: GuardSettings = {
    auto_charge_max_cents: clamp(s.auto_charge_max_cents ?? cur.auto_charge_max_cents, 0, 5_000_000),
    auto_refund_max_cents: clamp(s.auto_refund_max_cents ?? cur.auto_refund_max_cents, 0, 5_000_000),
    auto_discount_max_pct: clamp(s.auto_discount_max_pct ?? cur.auto_discount_max_pct, 0, 50),
  };
  await db.query("INSERT INTO guard_settings (id, auto_charge_max_cents, auto_refund_max_cents, auto_discount_max_pct, updated_at) VALUES ($1,$2,$3,$4,now()) ON CONFLICT (id) DO UPDATE SET auto_charge_max_cents = EXCLUDED.auto_charge_max_cents, auto_refund_max_cents = EXCLUDED.auto_refund_max_cents, auto_discount_max_pct = EXCLUDED.auto_discount_max_pct, updated_at = now()", [businessId, next.auto_charge_max_cents, next.auto_refund_max_cents, next.auto_discount_max_pct]);
  await appendAudit("guard.settings", "business", businessId, { ...next, by });
  return next;
}

export class GateDenied extends Error {
  constructor(message: string, readonly code: "denied" | "dry_run_refused") {
    super(message);
  }
}
export class HeldForApproval extends Error {
  constructor(message: string, readonly approvalId: string) {
    super(message);
  }
}

export interface GateDecision {
  decision: "allowed" | "dry_run_refused" | "held" | "denied";
  reason: string;
  policy: string | null;
  approvalId?: string;
  checks: { name: string; ok: boolean; note: string }[];
}

export function payloadHash(move: MoneyMove): string {
  const { action, entity, entityId, cents, discountPct, instalments } = move;
  return createHash("sha256").update(JSON.stringify({ action, entity, entityId, cents: cents ?? null, discountPct: discountPct ?? null, instalments: instalments ?? null })).digest("hex");
}

/** Decide without acting. PayPal is only read, never written; an approval row is created only when the decision is "held". */
export async function dryRun(move: MoneyMove, opts: { createApproval?: boolean; q?: Queryable } = {}): Promise<GateDecision> {
  const db = opts.q ?? (await getDb());
  const checks: GateDecision["checks"] = [];
  const deny = (reason: string, policy: string | null = null, decision: GateDecision["decision"] = "denied"): GateDecision => ({ decision, reason, policy, checks });

  // 1. Kill switches: global, all agents, this action, this agent.
  const scopes = ["global", `action:${move.action}`, move.agentScope, move.agentScope.startsWith("agent:") ? "agents" : null].filter(Boolean) as string[];
  for (const scope of scopes) {
    const k = await isKilled(scope, db);
    if (k?.engaged) {
      checks.push({ name: "kill switch", ok: false, note: `${k.scope} engaged: ${k.reason ?? ""}` });
      return deny(`Stopped by the kill switch on ${k.scope}${k.reason ? ` (${k.reason})` : ""}.`, `kill:${k.scope}`);
    }
  }
  checks.push({ name: "kill switch", ok: true, note: "no kill switch engaged for this move" });

  // 2. Money is a positive whole number of cents, and comes from somewhere trusted.
  const c = move.cents;
  if (c === undefined || typeof c !== "number" || !Number.isInteger(c) || c <= 0) {
    checks.push({ name: "integer money", ok: false, note: `amount ${String(c)} is not a positive whole number of cents` });
    return deny(`Refused before PayPal: amount ${String(c)} is not a positive whole number of cents.`, "money:integer", "dry_run_refused");
  }
  checks.push({ name: "integer money", ok: true, note: `${c} cents` });
  const prov = await moneyArgumentOk(move.entity, move.entityId, c, move.trustedCents ?? [], db);
  checks.push({ name: "provenance", ok: prov.ok, note: prov.reason });
  if (!prov.ok) return deny(`Refused before PayPal: ${prov.reason}.`, "money:provenance");

  // 3. The owner's policy: discount cap, instalment count and minimum, purposes are checked by the planner.
  const pol = await activePolicy(move.businessId, db);
  const settings = await guardSettings(move.businessId, db);
  if (move.action === "discount") {
    const pct = move.discountPct;
    const cap = Math.min(pol.rules.max_discount_pct, settings.auto_discount_max_pct);
    if (pct === undefined || !Number.isInteger(pct) || pct <= 0 || pct > cap) {
      checks.push({ name: "policy", ok: false, note: `discount ${String(pct)}% is outside the ${cap}% cap` });
      return deny(`Denied: a ${String(pct)}% discount is above the owner's ${cap}% cap.`, "policy:discount");
    }
    checks.push({ name: "policy", ok: true, note: `${pct}% is within the ${cap}% cap` });
  }
  if (move.action === "plan") {
    const n = move.instalments;
    if (n === undefined || !Number.isInteger(n) || n < 2 || n > pol.rules.max_instalments) {
      checks.push({ name: "policy", ok: false, note: `${String(n)} instalments is outside 2–${pol.rules.max_instalments}` });
      return deny(`Denied: ${String(n)} instalments is outside the owner's limit of ${pol.rules.max_instalments}.`, "policy:instalments");
    }
    if (Math.floor(c / n) < pol.rules.min_instalment_cents) {
      checks.push({ name: "policy", ok: false, note: `instalments of ${Math.floor(c / n)} cents are under the ${pol.rules.min_instalment_cents}-cent minimum` });
      return deny(`Denied: each instalment would be under the owner's minimum of $${(pol.rules.min_instalment_cents / 100).toFixed(2)}.`, "policy:min_instalment");
    }
    checks.push({ name: "policy", ok: true, note: `${n} instalments within the policy` });
  }

  // 4. Live PayPal state: refuse moves the real order or capture cannot take.
  const ids = move.paypal ?? null;
  if (ids && (ids.captureId || ids.orderId) && paypalConfigured()) {
    try {
      const pp = paypal();
      if (move.action === "refund" && ids.captureId) {
        const cap = await pp.getCapture(ids.captureId);
        if (!["COMPLETED", "PARTIALLY_REFUNDED"].includes(cap.status)) {
          checks.push({ name: "live PayPal state", ok: false, note: `capture is ${cap.status}` });
          return deny(`Refused before PayPal: the capture is ${cap.status}, so it cannot be refunded.`, "paypal:status", "dry_run_refused");
        }
        const capCents = Math.round(Number(cap.amount.value) * 100);
        if (c > capCents) {
          checks.push({ name: "live PayPal state", ok: false, note: `refund ${c} is above the ${capCents} captured` });
          return deny(`Refused before PayPal: ${(c / 100).toFixed(2)} is more than the ${(capCents / 100).toFixed(2)} captured.`, "paypal:amount", "dry_run_refused");
        }
        checks.push({ name: "live PayPal state", ok: true, note: `capture ${cap.status}, ${(capCents / 100).toFixed(2)}` });
      } else if (move.action === "charge" && ids.orderId) {
        const o = await pp.getOrder(ids.orderId);
        if (!["APPROVED", "CREATED", "SAVED", "PAYER_ACTION_REQUIRED"].includes(o.status)) {
          checks.push({ name: "live PayPal state", ok: false, note: `order is ${o.status}` });
          return deny(`Refused before PayPal: the order is ${o.status}.`, "paypal:status", "dry_run_refused");
        }
        checks.push({ name: "live PayPal state", ok: true, note: `order ${o.status}` });
      }
    } catch (e) {
      checks.push({ name: "live PayPal state", ok: false, note: `could not read PayPal: ${(e as Error).message.slice(0, 120)}` });
      return deny("Refused before PayPal: the payment could not be read back, so the move is not attempted.", "paypal:unreadable", "dry_run_refused");
    }
  }

  // 5. Autonomy limits (never for a person's own click).
  if (!move.personInitiated) {
    const limit = move.action === "refund" ? Math.min(settings.auto_refund_max_cents, pol.rules.auto_refund_max_cents) : move.action === "discount" ? Infinity : Math.min(settings.auto_charge_max_cents, pol.rules.auto_charge_max_cents);
    const name = move.action === "refund" ? "refund" : move.action === "discount" ? "discount" : "charge";
    if (c > limit) {
      checks.push({ name: "autonomy", ok: false, note: `${c} cents is above the owner's ${limit}-cent ${name} limit` });
      return await hold(`${(c / 100).toFixed(2)} ${move.action} needs the owner (autonomy ${(limit / 100).toFixed(2)}).`, `autonomy.${name}`);
    }
    checks.push({ name: "autonomy", ok: true, note: Number.isFinite(limit) ? `${c} cents is within the ${limit}-cent ${name} limit` : "discounts are bounded by the cap above" });
  } else checks.push({ name: "autonomy", ok: true, note: "a person's own click is their approval" });

  return { decision: "allowed", reason: "within the policy, autonomy and live PayPal state", policy: null, checks };

  async function hold(reason: string, policy: string): Promise<GateDecision> {
    if (!opts.createApproval) return { decision: "held", reason, policy, checks };
    const id = newId("apr");
    const hash = payloadHash(move);
    await db.query("INSERT INTO approvals (id, action, payload_hash, payload, status) VALUES ($1,$2,$3,$4,'pending')", [id, move.action, hash, JSON.stringify({ ...move, reason })]);
    await appendAudit("approval.requested", "approval", id, { action: move.action, cents: move.cents ?? null, entity: move.entity, entityId: move.entityId, hash });
    await notifyParty("owner", move.businessId, `Callback held a ${move.action} of ${((move.cents ?? 0) / 100).toFixed(2)} (${reason}). Approve or decline.`, [{ id: `approve:${id}`, label: "Approve" }, { id: `decline:${id}`, label: "Decline" }], "approval", id, db);
    return { decision: "held", reason, policy, approvalId: id, checks };
  }
}

/** The gate: a dry run whose decision is recorded as a trace step; anything but "allowed" throws. */
export async function gate(move: MoneyMove, run: Run | null, q?: Queryable): Promise<GateDecision> {
  const t0 = Date.now();
  const args = { entity: move.entity, entityId: move.entityId, cents: move.cents ?? null, agentScope: move.agentScope, discountPct: move.discountPct ?? null, instalments: move.instalments ?? null };
  if (await approvedFor(move, q)) {
    const d: GateDecision = { decision: "allowed", reason: "the owner approved this exact move", policy: "approval", checks: [{ name: "approval", ok: true, note: `payload ${payloadHash(move).slice(0, 12)} approved` }] };
    if (run) await run.step({ actor: "guard", tool: `gate.${move.action}`, args, policy: d.policy, gate: d.decision, result: { reason: d.reason, checks: d.checks }, duration_ms: Date.now() - t0 });
    return d;
  }
  const d = await dryRun(move, { createApproval: true, q });
  if (run) await run.step({ actor: "guard", tool: `gate.${move.action}`, args, policy: d.policy, gate: d.decision, result: { reason: d.reason, checks: d.checks, approvalId: d.approvalId ?? null }, duration_ms: Date.now() - t0 });
  if (d.decision === "held") throw new HeldForApproval(d.reason, d.approvalId ?? "");
  if (d.decision !== "allowed") throw new GateDenied(d.reason, d.decision);
  return d;
}

/** Owner decides a held move; above the countersign threshold the decision must carry a passkey. */
export async function decideApproval(id: string, approve: boolean, method: "click" | "passkey" | "channel", by: string, businessId?: string) {
  const db = await getDb();
  const a = (await db.query<any>("SELECT * FROM approvals WHERE id = $1", [id])).rows[0];
  if (!a) throw new Error("No such approval");
  const payload = typeof a.payload === "string" ? JSON.parse(a.payload) : a.payload;
  if (businessId && payload.businessId && payload.businessId !== businessId) throw new Error("No such approval");
  if (a.status !== "pending") return { status: a.status as string, replayed: true, payload };
  const cents = Number(payload.cents ?? 0);
  if (approve && cents >= config.guard.countersignAboveCents && method !== "passkey") {
    const { hasPasskey } = await import("./passkey.js");
    if (await hasPasskey(payload.businessId ?? businessId ?? "", db)) throw new Error(`Approvals of ${(cents / 100).toFixed(2)} and above need your passkey.`);
  }
  await db.query("UPDATE approvals SET status = $2, method = $3, decided_at = now() WHERE id = $1", [id, approve ? "approved" : "declined", method]);
  await appendAudit(approve ? "approval.approved" : "approval.declined", "approval", id, { by, method, hash: a.payload_hash, action: a.action });
  return { status: approve ? "approved" : "declined", payload, replayed: false };
}

export async function pendingApprovals(businessId?: string) {
  const db = await getDb();
  const rows = (await db.query<any>("SELECT * FROM approvals ORDER BY created_at DESC LIMIT 200")).rows.map((r) => ({ ...r, payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload }));
  return businessId ? rows.filter((r) => !r.payload.businessId || r.payload.businessId === businessId) : rows;
}

/** Has the owner approved this exact move in the last day? Then the retry goes straight through. */
export async function approvedFor(move: MoneyMove, q?: Queryable): Promise<boolean> {
  const db = q ?? (await getDb());
  const hash = payloadHash(move);
  return (await db.query("SELECT 1 FROM approvals WHERE payload_hash = $1 AND status = 'approved' AND decided_at > now() - interval '1 day' LIMIT 1", [hash])).rows.length > 0;
}
