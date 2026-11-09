/**
 * MCP (roadmap B.3, E.4). Owner server: read the plan, the calls, the policy, the guard; place or skip a call; decide
 * approvals (hand-click equivalent, so no hold); compile a policy draft. Customer server (by status token): see what
 * is owed and get a pay link or ask for a callback. Every tool runs under a run with the agent id; money moves go
 * through the same services and gate as the UI.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../db.js";
import { compileLocal, compilePolicy, activePolicy, listPolicies } from "../guard/policy.js";
import { decideApproval, pendingApprovals, guardSettings } from "../guard/dryrun.js";
import { listKills } from "../guard/kill.js";
import { verifyChain } from "../guard/audit.js";
import { backtest, history } from "../guard/backtest.js";
import { balanceOf, callById, callsOf, customerById, customersOf, eventsOf, obligationsOf, type Customer } from "../store.js";
import { candidates } from "../services/planner.js";
import { skipCall } from "../services/calls.js";
import { placeCall } from "../voice/telephony.js";
import { loadRun, startRun } from "../trace.js";
import { sendPayLink } from "../services/money.js";
import { callbackSlots } from "../core/plans.js";
import { nowOf, bizById } from "../store.js";

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true as const });

export function buildOwnerServer(businessId: string, agentId: string): McpServer {
  const s = new McpServer({ name: "callback-owner", version: "0.1.0" });
  s.registerTool("get_plan", { description: "Today's call candidates with the consent/hours verdict for each (what will and will not be called, and why).", inputSchema: {} }, async () => {
    const db = await getDb();
    const cs = await candidates(db, businessId);
    return text(cs.map((c) => ({ purpose: c.purpose, customer: c.customer.name, item: c.obligation.title, balance: balanceOf(c.obligation) / 100, reason: c.reason, callable: c.verdict.ok, blocked_because: c.verdict.reasons, next_window: c.verdict.next_window })));
  });
  s.registerTool("list_calls", { description: "Calls by status.", inputSchema: { status: z.enum(["planned", "blocked", "in_progress", "ended", "skipped"]).optional() } }, async ({ status }) => {
    const db = await getDb();
    const rows = await callsOf(db, businessId, { status: status ? [status as any] : undefined, limit: 100 });
    return text(rows.map((c) => ({ id: c.id, purpose: c.purpose, status: c.status, mode: c.mode, outcome: c.outcome, reason: c.reason, collected: c.collected_cents / 100, breaches: c.breaches, run_id: c.run_id })));
  });
  s.registerTool("get_call", { description: "One call with its transcript (customer lines marked with what was quarantined) and state.", inputSchema: { call_id: z.string() } }, async ({ call_id }) => {
    const db = await getDb();
    try {
      const c = await callById(db, call_id, businessId);
      return text({ ...c, transcript: c.transcript });
    } catch (e) {
      return fail((e as Error).message);
    }
  });
  s.registerTool("place_call", { description: "Place a planned call now (phone when Twilio is set, otherwise the simulator). Consent and hours are re-checked in code; a blocked call stays blocked.", inputSchema: { call_id: z.string() } }, async ({ call_id }) => {
    const db = await getDb();
    try {
      await callById(db, call_id, businessId);
      const r = await placeCall(call_id, `mcp:${agentId}`);
      return text({ placed: true, ...r });
    } catch (e) {
      return fail((e as Error).message);
    }
  });
  s.registerTool("skip_call", { description: "Skip a planned call with a reason.", inputSchema: { call_id: z.string(), reason: z.string().max(200) } }, async ({ call_id, reason }) => {
    const db = await getDb();
    try {
      await callById(db, call_id, businessId);
      await skipCall(db, call_id, reason, `mcp:${agentId}`);
      return text({ skipped: true });
    } catch (e) {
      return fail((e as Error).message);
    }
  });
  s.registerTool("list_customers", { description: "Customers with consent and do-not-call state.", inputSchema: {} }, async () => {
    const db = await getDb();
    return text((await customersOf(db, businessId)).map((c) => ({ id: c.id, name: c.name, tz: c.tz, consent: c.consent ? (c.consent.revoked_at ? "revoked" : "granted") : "none", dnc: c.dnc })));
  });
  s.registerTool("get_policy", { description: "The active call policy: the owner's words and the rules the gate enforces.", inputSchema: {} }, async () => text(await activePolicy(businessId)));
  s.registerTool("draft_policy", { description: "Compile plain-words policy text into rules and backtest it; does not activate.", inputSchema: { text: z.string().max(4000) } }, async ({ text: t }) => {
    const db = await getDb();
    const run = await startRun({ actor: "agent", agentId, subject: "Draft policy", entity: "business", entityId: businessId }, db);
    const compiled = await compilePolicy(t, run.id);
    const bt = backtest(await history(businessId, db), compiled.rules, await guardSettings(businessId, db));
    await run.step({ actor: "code", tool: "policy.compile", result: { source: compiled.source, refused: compiled.refused } });
    await run.end("done");
    return text({ rules: compiled.rules, unexpressed: compiled.unexpressed, refused: compiled.refused, backtest: { cases: bt.cases, run: bt.run, wait: bt.wait, deny: bt.deny, collected_auto: bt.collected_auto_cents / 100, minutes_saved: bt.minutes_saved } });
  });
  s.registerTool("list_approvals", { description: "Pending and recent holds.", inputSchema: {} }, async () => text((await pendingApprovals(businessId)).map((a) => ({ id: a.id, action: a.action, status: a.status, cents: a.payload.cents, reason: a.payload.reason, created_at: a.created_at }))));
  s.registerTool("decide_approval", { description: "Approve or decline a held money move as the owner. Above the countersign threshold the UI passkey is required instead.", inputSchema: { approval_id: z.string(), approve: z.boolean() } }, async ({ approval_id, approve }) => {
    try {
      return text(await decideApproval(approval_id, approve, "click", `mcp:${agentId}`, businessId));
    } catch (e) {
      return fail((e as Error).message);
    }
  });
  s.registerTool("get_guard", { description: "Kill switches, autonomy limits and audit chain state.", inputSchema: {} }, async () => text({ kills: await listKills(), limits: await guardSettings(businessId), audit: await verifyChain() }));
  s.registerTool("get_trace", { description: "An agent run's step-by-step trace.", inputSchema: { run_id: z.string() } }, async ({ run_id }) => {
    const t = await loadRun(run_id);
    return t ? text(t) : fail("No such run");
  });
  s.registerTool("recent_events", { description: "Recent events for the business.", inputSchema: { limit: z.number().int().min(1).max(200).optional() } }, async ({ limit }) => text(await eventsOf(await getDb(), businessId, {}, limit ?? 50)));
  s.registerTool("list_policies", { description: "Policy history (drafts, active, retired).", inputSchema: {} }, async () => text(await listPolicies(businessId)));
  return s;
}

export function buildCustomerServer(customer: Customer, agentId: string): McpServer {
  const s = new McpServer({ name: "callback-customer", version: "0.1.0" });
  s.registerTool("my_account", { description: "What is owed, what is paid, and whether the business may call you.", inputSchema: {} }, async () => {
    const db = await getDb();
    const obls = await obligationsOf(db, customer.business_id, customer.id);
    return text({ name: customer.name, consent: customer.consent ? (customer.consent.revoked_at ? "revoked" : "granted") : "none", dnc: customer.dnc, items: obls.map((o) => ({ id: o.id, title: o.title, kind: o.kind, status: o.status, balance: balanceOf(o) / 100, due: o.due_at, appointment: o.appointment_at })) });
  });
  s.registerTool("get_pay_link", { description: "Get a PayPal link for one open item (your own request: not held).", inputSchema: { obligation_id: z.string() } }, async ({ obligation_id }) => {
    const db = await getDb();
    const o = (await obligationsOf(db, customer.business_id, customer.id)).find((x) => x.id === obligation_id);
    if (!o) return fail("Not one of your items");
    const biz = await bizById(db, customer.business_id);
    const run = await startRun({ actor: "customer", agentId, subject: `Pay link requested by ${customer.name}`, entity: "obligation", entityId: o.id }, db);
    try {
      const r = await sendPayLink({ q: db, run, businessId: biz.id, businessName: biz.name, callId: null, agentScope: `customer:${customer.id}`, personInitiated: true }, o, customer);
      await run.end("done");
      return text({ approve_url: r.approveUrl, amount: r.cents / 100 });
    } catch (e) {
      await run.end("failed");
      return fail((e as Error).message);
    }
  });
  s.registerTool("callback_slots", { description: "Times the business may call you back, in your time zone.", inputSchema: {} }, async () => {
    const db = await getDb();
    const pol = await activePolicy(customer.business_id, db);
    return text(callbackSlots(await nowOf(db, customer.business_id), customer.tz, pol.rules, 6));
  });
  s.registerTool("stop_calls", { description: "Revoke consent to be called. Immediate; recorded on the audit chain.", inputSchema: {} }, async () => {
    const db = await getDb();
    await db.query("UPDATE customers SET dnc = true, consent = jsonb_set(coalesce(consent, '{}'::jsonb), '{revoked_at}', to_jsonb(now()::text)) WHERE id = $1", [customer.id]);
    const { appendAudit } = await import("../guard/audit.js");
    await appendAudit("consent.revoked", "customer", customer.id, { by: `mcp:${agentId}` });
    return text({ dnc: true });
  });
  return s;
}

export { compileLocal, customerById };
