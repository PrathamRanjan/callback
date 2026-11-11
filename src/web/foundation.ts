import { randomBytes } from "node:crypto";
import { icon } from "./icons.js";
/**
 * Foundation routes (roadmap B.2, B.3, B.4, B.5, B.7, B.8, B.10): traces, eval explorer, money desk, channels and
 * webhooks (Telegram, WhatsApp, Twilio SMS, PayPal), PWA, evidence page, judge mode, llms.txt, skill.md, MCP.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Router, type Request } from "express";
import { aiUsageSummary, hasOpenAI, providerLabel } from "../ai/provider.js";
import { conversation, receive, recentMessages, smsReady, smsUpdate, telegramReady, telegramUpdate, whatsappUpdate } from "../channels/index.js";
import { pushReady, subscribe } from "../channels/push.js";
import { routeTelegram } from "../channels/router.js";
import { config } from "../config.js";
import { currentWs, getDb, inWorkspace } from "../db.js";
import { getWorkspace, splitCustomId, wsForRef, wsFromSecret } from "../services/workspaces.js";
import { CASES, harnessContext, renderAdversarialReport, runAdversarial } from "../eval/adversarial.js";
import { personas, renderPersonaReport, runPersonaSuite } from "../eval/personas.js";
import { evalRows, summarise, toCsv } from "../eval/store.js";
import { verifyChain } from "../guard/audit.js";
import { backtest, history } from "../guard/backtest.js";
import { guardSettings } from "../guard/dryrun.js";
import { activePolicy } from "../guard/policy.js";
import { newId } from "../lib/ids.js";
import { GtError } from "../lib/util.js";
import { paypal, paypalConfigured, PayPalError, WEBHOOK_EVENTS, withMockResponse } from "../paypal/index.js";
import { readBack } from "../services/money.js";
import { buildCustomerServer, buildOwnerServer } from "../mcp/tools.js";
import { agentIdOf, serveMcp } from "../mcp/http.js";
import { balanceOf, callsOf, customerByToken, firstBiz, obligationsOf } from "../store.js";
import { loadRun, recentRuns, renderTrace, startRun } from "../trace.js";
import { realtimeReady } from "../voice/realtime.js";
import { telephonyReady, webhookAuthorised } from "../voice/telephony.js";
import { act, authed, me, ownerOnly, requireOwner } from "./auth.js";
import { back, flashOf, json, page } from "./common.js";
import { killBanner } from "./guard.js";
import { esc, fmtDate, html, layout, pill, raw } from "./html.js";
import { rulesTable } from "./owner.js";
import { money, ownerPage, stat } from "./views.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const errMsg = (e: unknown) => (e instanceof GtError ? e.message : (e as Error).message);

export function foundationRouter(): Router {
  const r = Router();

  /* ---------------- traces (B.2) ---------------- */
  r.get("/trace/:id", page(async (req, res) => {
    const t = await loadRun(req.params.id);
    if (!t) return res.status(404).send("No such run");
    const p = await me(req);
    const db = await getDb();
    let allowed = Boolean(p) || config.demoMode;
    let tokenCustomer: Awaited<ReturnType<typeof customerByToken>> | null = null;
    if (!p && typeof req.query.token === "string") {
      tokenCustomer = await customerByToken(db, req.query.token).catch(() => null);
      if (tokenCustomer) {
        const ids = new Set<string>([...(await obligationsOf(db, tokenCustomer.business_id, tokenCustomer.id)).map((o) => o.id), ...(await callsOf(db, tokenCustomer.business_id, { customerId: tokenCustomer.id })).map((c) => c.id)]);
        allowed = ids.has(String(t.run.entity_id));
      }
    }
    if (!allowed) return res.status(403).send("This run is not yours to see");
    const body = html`<h1>What happened, step by step</h1><p class="muted">${t.run.subject} · ${t.run.actor}${t.run.agent_id ? ` (${t.run.agent_id})` : ""} · <span class="pill ${t.run.status === "done" ? "good" : t.run.status === "held" ? "warn" : t.run.status === "running" ? "info" : "bad"}">${t.run.status}</span> · started ${fmtDate(t.run.started_at)}</p><div class="card">${renderTrace(t.steps)}</div><p class="small muted">Every step is a row in agent_trace: actor, tool, redacted arguments, the rule hit, the gate's decision, PayPal request and debug ids, duration. ${p ? html`<a href="/api/v1/runs/${t.run.id}">JSON</a>` : ""}</p>`;
    if (p) return res.send(await ownerPage(req, p, `Run ${t.run.id}`, body));
    res.send(layout({ title: `Run ${t.run.id}`, customer: tokenCustomer ? { business: (await db.query<{ name: string }>("SELECT name FROM businesses WHERE id = $1", [tokenCustomer.business_id])).rows[0]?.name ?? "" } : null }, body));
  }));
  r.get("/ops/traces", authed(async (req, res, p) => {
    const runs = await recentRuns(100);
    res.send(await ownerPage(req, p, "Agent runs", html`<h1>Agent runs</h1><p class="muted">Every run: the planner, each call, the worker's read-back, customers and their agents.</p>${await killBanner()}<div class="card"><div class="table-wrap"><table><tr><th>Started</th><th>Actor</th><th>Subject</th><th>Steps</th><th>PayPal calls</th><th>Blocked</th><th>Status</th></tr>${runs.map((x: any) => html`<tr><td class="small">${fmtDate(x.started_at)}</td><td>${x.actor}${x.agent_id ? html`<br><small class="muted">${x.agent_id}</small>` : ""}</td><td><a href="/trace/${x.id}">${x.subject}</a></td><td>${x.steps}</td><td>${x.paypal_calls}</td><td>${Number(x.blocked) ? html`<span class="pill warn">${x.blocked}</span>` : "0"}</td><td><span class="pill ${x.status === "done" ? "good" : x.status === "held" ? "warn" : x.status === "running" ? "info" : "bad"}">${x.status}</span></td></tr>`)}</table></div>${runs.length ? "" : html`<div class="empty">No runs yet.</div>`}</div>`));
  }));
  r.get("/api/v1/runs/:id", json(async (req) => {
    await requireOwner(req);
    const t = await loadRun(req.params.id);
    if (!t) throw new GtError("No such run", "not_found", 404);
    return t;
  }));
  r.get("/api/v1/runs", json(async (req) => {
    await requireOwner(req);
    return recentRuns(100);
  }));

  /* ---------------- eval explorer (B.5) ---------------- */
  r.get("/ops/eval", authed(async (req, res, p) => {
    const suite = typeof req.query.suite === "string" && ["personas", "adversarial"].includes(req.query.suite) ? req.query.suite : "personas";
    const f = { arm: typeof req.query.arm === "string" ? req.query.arm : undefined, outcome: req.query.outcome === "correct" || req.query.outcome === "wrong" ? (req.query.outcome as "correct" | "wrong") : undefined, trap: typeof req.query.trap === "string" ? req.query.trap : undefined };
    const sums = await summarise(suite);
    const rows = await evalRows(suite, f, 1000);
    const q = (patch: Record<string, string | undefined>) => { const u = new URLSearchParams({ suite, ...(f.arm ? { arm: f.arm } : {}), ...(f.outcome ? { outcome: f.outcome } : {}), ...(f.trap ? { trap: f.trap } : {}) }); for (const [k, v] of Object.entries(patch)) v === undefined ? u.delete(k) : u.set(k, v); return `/ops/eval?${u}`; };
    const chip = (label: string, patch: Record<string, string | undefined>, on: boolean) => html`<a class="chip ${on ? "on" : ""}" href="${q(patch)}">${label}</a>`;
    const kinds = suite === "personas" ? ["agreeable", "confused", "hostile", "haggler", "plan_seeker"] : ["speech", "authority", "policy", "provenance", "consent", "kill", "amount"];
    res.send(await ownerPage(req, p, "Evals", html`<h1>Evals</h1><p class="muted">Brain: ${providerLabel()}. Persona suite: ${personas().length} scripted customers × arms. Adversarial: ${CASES.length} attacks.</p>
<div class="chips">${chip("Personas", { suite: "personas", arm: undefined, trap: undefined }, suite === "personas")}${chip("Adversarial", { suite: "adversarial", arm: undefined, trap: undefined }, suite === "adversarial")}</div>
<div class="callbar"><form method="post" action="/ops/eval/run" class="inline"><input type="hidden" name="suite" value="${suite}"><input type="hidden" name="limit" value="${suite === "personas" ? "12" : ""}"><button class="btn primary" type="submit">Run ${suite === "personas" ? "12 personas (quick)" : "all attacks"}</button></form>${suite === "personas" ? html`<form method="post" action="/ops/eval/run" class="inline"><input type="hidden" name="suite" value="personas"><button class="btn" type="submit">Run all ${personas().length}</button></form>` : ""}<a class="btn" href="/ops/eval/${suite}.md">Markdown</a><a class="btn" href="/ops/eval.csv?${new URLSearchParams({ suite })}">CSV</a></div>
<div class="card"><table><tr><th>Arm</th><th>Cases</th><th>${suite === "personas" ? "Clean outcome" : "Blocked"}</th><th>Traps</th><th>Traps caught</th><th>Naive $</th><th>Ours $</th><th>Model cost</th><th>p50 ms</th><th>p95 ms</th></tr>${sums.map((s) => html`<tr><td>${s.arm}</td><td>${s.cases}</td><td>${s.correct}</td><td>${s.traps}</td><td>${s.traps_caught}</td><td>${s.naive_usd.toFixed(2)}</td><td>${s.ours_usd.toFixed(2)}</td><td>$${s.cost_usd.toFixed(4)}</td><td>${s.p50_ms}</td><td>${s.p95_ms}</td></tr>`)}</table>${sums.length ? "" : html`<div class="empty">Not run yet.</div>`}</div>
<div class="chips">${chip("All arms", { arm: undefined }, !f.arm)}${sums.map((s) => chip(s.arm, { arm: s.arm }, f.arm === s.arm))}<span class="muted">·</span>${chip("All", { outcome: undefined }, !f.outcome)}${chip(suite === "personas" ? "Clean" : "Blocked", { outcome: "correct" }, f.outcome === "correct")}${chip(suite === "personas" ? "Not clean" : "NOT blocked", { outcome: "wrong" }, f.outcome === "wrong")}<span class="muted">·</span>${chip("Any kind", { trap: undefined }, !f.trap)}${kinds.map((k) => chip(k, { trap: k }, f.trap === k))}</div>
<div class="card"><div class="table-wrap"><table class="small"><tr><th>Case</th><th>Arm</th><th>Expected</th><th>Actual</th><th>${suite === "personas" ? "Clean" : "Blocked"}</th><th>Kind</th><th>Naive</th><th>Ours</th><th>Detail</th></tr>${rows.map((x: any) => html`<tr><td>${x.case_id}</td><td>${x.arm}</td><td>${String(x.expected)}</td><td>${String(x.actual)}</td><td>${x.correct ? pill("paid", "yes") : pill("declined", "no")}</td><td>${x.detail?.trap_kind ?? ""}</td><td>${(Number(x.naive_paid_cents) / 100).toFixed(2)}</td><td>${(Number(x.ours_paid_cents) / 100).toFixed(2)}</td><td><details><summary>…</summary><pre>${JSON.stringify(x.detail, null, 1)}</pre></details></td></tr>`)}</table></div>${rows.length ? "" : html`<div class="empty">No rows match.</div>`}</div>`));
  }));
  r.post("/ops/eval/run", act(async (req, res, p) => {
    ownerOnly(p);
    const suite = String(req.body.suite);
    const db = await getDb();
    if (suite === "adversarial") {
      const ctx = await harnessContext(db);
      if (!ctx) throw new GtError("Seed first.", "no_data");
      const out = await runAdversarial(ctx, db);
      writeReport("adversarial.md", await renderAdversarialReport(out));
      return back(res, "/ops/eval?suite=adversarial", `${out.filter((x) => x.caught).length}/${out.length} attacks blocked.`);
    }
    const limit = req.body.limit ? Number(req.body.limit) : undefined;
    const out = await runPersonaSuite(undefined, limit);
    writeReport("personas.md", await renderPersonaReport());
    back(res, "/ops/eval?suite=personas", `${out.length} persona runs recorded.`);
  }));
  r.get("/ops/eval.csv", authed(async (req, res) => {
    const suite = String(req.query.suite ?? "personas");
    res.type("text/csv").attachment(`${suite}.csv`).send(toCsv(await evalRows(suite, {}, 5000)));
  }));
  r.get("/ops/eval/:suite.md", authed(async (req, res) => {
    const s = req.params.suite;
    const md = s === "adversarial" ? await renderAdversarialReport((await evalRows("adversarial", {}, 500)).map((x: any) => ({ id: x.case_id, family: x.detail?.trap_kind ?? "", description: x.detail?.description ?? "", caught: Boolean(x.correct), rule: x.detail?.rule ?? "", detail: x.detail?.detail }))) : await renderPersonaReport();
    res.type("text/markdown").send(md);
  }));

  /* ---------------- money desk (B.7) ---------------- */
  r.get("/ops/money", authed(async (req, res, p) => {
    ownerOnly(p);
    const db = await getDb();
    const obls = await obligationsOf(db, p.business_id);
    const links = (await db.query<any>("SELECT * FROM pay_links WHERE business_id = $1 ORDER BY created_at DESC LIMIT 30", [p.business_id])).rows;
    const invs = (await db.query<any>("SELECT * FROM invoices WHERE business_id = $1 ORDER BY created_at DESC LIMIT 30", [p.business_id])).rows;
    const plans = (await db.query<any>("SELECT * FROM instalment_plans WHERE business_id = $1 ORDER BY created_at DESC LIMIT 30", [p.business_id])).rows;
    const refunds = (await db.query<any>("SELECT * FROM refunds WHERE business_id = $1 ORDER BY created_at DESC LIMIT 30", [p.business_id])).rows;
    const hooks = (await db.query<any>("SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT 20")).rows;
    let balances: any[] = [];
    let txns: any[] = [];
    if (paypalConfigured()) {
      try {
        balances = await paypal().listBalances();
        txns = await paypal().searchTransactions({ start: new Date(Date.now() - 30 * 86400_000), end: new Date() });
      } catch { /* shown as unavailable */ }
    }
    const owed = obls.filter((o) => !["paid", "credited", "refunded", "void"].includes(o.status)).reduce((s, o) => s + balanceOf(o), 0);
    res.send(await ownerPage(req, p, "Money", html`<h1>Money</h1><p class="muted">PayPal is the truth for what was paid. Read-back reconciles every tick; nothing here is edited by hand.</p>
<div class="scorecard">${stat("Owed", money(owed))}${stat("Paid", money(obls.filter((o) => o.status === "paid").reduce((s, o) => s + o.settled_cents, 0)))}${stat("Pay links", links.length)}${stat("Invoices", invs.length)}${stat("Plans", plans.length)}${stat("Refunds", refunds.length)}</div>
<form method="post" action="/ops/money/readback" class="callbar"><button class="btn" type="submit">Read back from PayPal now</button>${paypalConfigured() ? "" : html`<span class="small muted">PayPal is not configured; reads are skipped.</span>`}</form>
<div class="grid2"><div class="card"><h3>Pay links</h3><table class="small"><tr><th>When</th><th>Amount</th><th>Order</th><th>Status</th></tr>${links.map((x: any) => html`<tr><td>${fmtDate(x.created_at)}</td><td>${money(Number(x.amount_cents))}</td><td class="mono">${x.paypal_order_id ?? ""}</td><td>${pill(x.status === "unknown" ? "warn" : x.status, x.status)}</td></tr>`)}</table>
<h3>Invoices</h3><table class="small"><tr><th>When</th><th>Amount</th><th>Invoice</th><th>Status</th></tr>${invs.map((x: any) => html`<tr><td>${fmtDate(x.created_at)}</td><td>${money(Number(x.amount_cents))}</td><td class="mono">${x.paypal_invoice_id ?? ""}</td><td>${pill(x.status, x.status)}</td></tr>`)}</table></div>
<div class="card"><h3>Instalment plans</h3><table class="small"><tr><th>When</th><th>Plan</th><th>Subscription</th><th>Status</th></tr>${plans.map((x: any) => html`<tr><td>${fmtDate(x.created_at)}</td><td>${(typeof x.option === "string" ? JSON.parse(x.option) : x.option).label}</td><td class="mono">${x.subscription_id ?? ""}</td><td>${pill(x.status, x.status)}</td></tr>`)}</table>
<h3>Refunds</h3><table class="small"><tr><th>When</th><th>Amount</th><th>Refund</th><th>Status</th></tr>${refunds.map((x: any) => html`<tr><td>${fmtDate(x.created_at)}</td><td>${money(Number(x.amount_cents))}</td><td class="mono">${x.paypal_refund_id ?? ""}</td><td>${pill(x.status, x.status)}</td></tr>`)}</table></div></div>
<div class="grid2"><div class="card"><h3>PayPal balances and last 30 days</h3>${balances.length ? html`<p>${balances.map((b: any) => `${b.currency} ${b.total_balance?.value}`).join(" · ")}</p>` : html`<p class="muted small">Not available.</p>`}<table class="small">${txns.slice(0, 15).map((t: any) => html`<tr><td>${String(t.transaction_initiation_date).slice(0, 10)}</td><td>${t.event_code ?? ""}</td><td>${t.transaction_amount?.value}</td><td class="mono">${t.transaction_id}</td></tr>`)}</table></div>
<div class="card"><h3>Negative paths</h3><p class="small muted">Run a money move against a canned PayPal reply to show the agent's honesty when PayPal misbehaves.</p><form method="post" action="/ops/money/negative" class="callbar"><select name="case"><option value="capture_declined">capture returns DECLINED</option><option value="order_voided">order read back as VOIDED</option><option value="refund_422">refund rejected (422)</option><option value="invoice_404">invoice not found</option></select><button class="btn" type="submit">Run</button></form>
<h3>Webhooks</h3><form method="post" action="/ops/money/webhook/simulate" class="callbar"><select name="event">${WEBHOOK_EVENTS.map((e) => html`<option>${e}</option>`)}</select><button class="btn" type="submit">Simulate (sandbox)</button></form><table class="small">${hooks.map((h: any) => html`<tr><td>${fmtDate(h.received_at)}</td><td>${h.event_type}</td><td>${h.verified ? pill("paid", "verified") : pill("warn", "unverified")}</td></tr>`)}</table></div></div>`));
  }));
  r.post("/ops/money/readback", act(async (req, res, p) => {
    ownerOnly(p);
    const db = await getDb();
    if (!paypalConfigured()) throw new GtError("PayPal is not configured.", "no_paypal");
    const run = await startRun({ actor: "owner", subject: "Read back PayPal state", entity: "business", entityId: p.business_id }, db);
    const n = await readBack(db, p.business_id, run);
    await run.end("done");
    back(res, "/ops/money", `${n} obligation${n === 1 ? "" : "s"} updated from PayPal.`);
  }));
  r.post("/ops/money/negative", act(async (req, res, p) => {
    ownerOnly(p);
    const db = await getDb();
    if (!paypalConfigured()) throw new GtError("PayPal is not configured.", "no_paypal");
    const c = String(req.body.case);
    const run = await startRun({ actor: "owner", subject: `Negative path: ${c}`, entity: "business", entityId: p.business_id }, db);
    let note = "";
    try {
      if (c === "capture_declined") note = await withMockResponse("getCapture", { id: "X", status: "DECLINED", amount: { value: "1.00", currency_code: "USD" } }, async () => { const { dryRun } = await import("../guard/dryrun.js"); const d = await dryRun({ action: "refund", agentScope: "owner", entity: "obligation", entityId: "demo", businessId: p.business_id, cents: 100, trustedCents: [100], paypal: { captureId: "X" } }); await run.step({ actor: "guard", tool: "gate.refund", gate: d.decision, result: d }); return `${d.decision}: ${d.reason}`; });
      else if (c === "order_voided") note = await withMockResponse("getOrder", { id: "O", status: "VOIDED" }, async () => { const { dryRun } = await import("../guard/dryrun.js"); const d = await dryRun({ action: "charge", agentScope: "owner", entity: "obligation", entityId: "demo", businessId: p.business_id, cents: 100, trustedCents: [100], paypal: { orderId: "O" } }); await run.step({ actor: "guard", tool: "gate.charge", gate: d.decision, result: d }); return `${d.decision}: ${d.reason}`; });
      else if (c === "refund_422") note = await withMockResponse("refundCapture", new PayPalError("Refund amount exceeds the remaining capture", 422, "REFUND_AMOUNT_EXCEEDED", "dbg-1", null), async () => { try { await paypal().refundCapture("CAP", 100, "USD", "test", newId("rq")); return "unexpected success"; } catch (e) { await run.step({ actor: "paypal", tool: "payments.captures.refund", gate: "denied", result: { error: errMsg(e) }, pp_debug_id: "dbg-1" }); return `PayPal said: ${errMsg(e)}; the local refund row would stay failed and the owner sees it.`; } });
      else note = await withMockResponse("getInvoice", new PayPalError("Invoice not found", 404, "RESOURCE_NOT_FOUND", "dbg-2", null), async () => { try { await paypal().getInvoice("INV"); return "unexpected"; } catch (e) { await run.step({ actor: "paypal", tool: "invoices.get", gate: "denied", result: { error: errMsg(e) } }); return `PayPal said: ${errMsg(e)}; read-back leaves the obligation unchanged.`; } });
      await run.end("done");
    } catch (e) {
      await run.end("failed");
      throw e;
    }
    back(res, "/ops/money", `${note} Trace ${run.id}.`);
  }));
  r.post("/ops/money/webhook/simulate", act(async (req, res, p) => {
    ownerOnly(p);
    if (!paypalConfigured() || !config.paypal.webhookId) throw new GtError("Set PAYPAL_WEBHOOK_ID to simulate.", "no_webhook");
    const out = await paypal().simulateWebhookEvent(config.paypal.webhookId, String(req.body.event));
    back(res, "/ops/money", `Simulated ${req.body.event}: ${out.id}.`);
  }));
  r.post("/webhooks/paypal", page(async (req, res) => {
    const db = await getDb();
    const body = req.body ?? {};
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
    let verified = false;
    if (paypalConfigured() && config.paypal.webhookId) {
      try {
        verified = await paypal().verifyWebhookSignature(headers as Record<string, string | undefined>, body, config.paypal.webhookId);
      } catch { verified = false; }
    }
    // Which studio the event is for: the custom_id "<workspace>:<record>" set on every PayPal object made in a private
    // demo, else the id recorded when it was made, else the shared showcase studio.
    const rsc = body.resource ?? {};
    let ws = splitCustomId(rsc.custom_id ?? rsc.purchase_units?.[0]?.custom_id ?? rsc.detail?.reference ?? null).ws;
    for (const ref of [rsc.id, rsc.supplementary_data?.related_ids?.order_id, rsc.billing_agreement_id, rsc.invoice_id]) if (!ws && ref) ws = await wsForRef(String(ref));
    if (ws && !(await getWorkspace(ws))) ws = null;
    await inWorkspace(ws, async () => {
      await db.query("INSERT INTO webhook_events (id, event_type, resource_id, body, verified) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING", [String(body.id ?? newId("wh")), String(body.event_type ?? "unknown"), rsc.id ?? null, JSON.stringify(body), verified]);
      if (verified) {
        const { enqueue } = await import("../jobs.js");
        await enqueue(db, "read_back", {}, new Date(), `read_back:webhook:${body.id ?? Date.now()}`);
      }
    });
    res.status(verified ? 200 : 202).json({ received: true, verified, workspace: ws ? "private demo" : "showcase" });
  }));

  /* ---------------- channels (B.8) ---------------- */
  r.get("/ops/channels", authed(async (req, res, p) => {
    ownerOnly(p);
    const msgs = await recentMessages(80);
    const addr = typeof req.query.address === "string" ? req.query.address : null;
    const thread = addr ? await conversation(addr) : [];
    const tg = (await (await getDb()).query<{ n: number }>("SELECT count(*)::int AS n FROM party_links WHERE channel = 'telegram' AND party = 'owner' AND party_id = $1", [p.business_id])).rows[0]?.n ?? 0;
    res.send(await ownerPage(req, p, "Messages", html`<div class="page-head"><div><h1>Messages and alerts</h1><p>Where Callback reaches you and your customers outside a call.</p></div></div>
<section class="card" id="phone"><h2>Alerts on your phone</h2><p class="sub muted">When Callback holds a decision for you, it arrives on Telegram with Approve and Decline buttons, so the customer isn't left waiting.</p>
<div class="row">${tg ? pill("paid", "Telegram connected") : pill("warn", "Telegram not connected")}<form method="post" action="/connect/telegram" class="inline" target="_blank"><button class="btn primary" type="submit">${raw(icon("message"))}${tg ? "Connect another chat" : "Connect Telegram"}</button></form><button class="btn" type="button" id="push-sub">${raw(icon("zap"))}Turn on notifications in this browser</button></div>
<p class="small muted">Telegram opens with a one-time code that expires in 15 minutes; press Start and you're done. Text messages ${smsReady() ? "go out through Twilio" : "are shown here as previews until a Twilio number is connected"}; phone calls ${telephonyReady() ? "can dial real numbers through Twilio" : "run in the browser simulator"}${realtimeReady() ? ", and you can talk to the agent with your voice" : ""}.</p></section>
<div class="grid2"><div class="card"><h3>Message simulator</h3><p class="small muted">Reply as the owner (<code>owner:&lt;business id&gt;</code>) or a customer (<code>customer:&lt;token&gt;</code>). Type <code>approve:&lt;approval id&gt;</code> to decide a hold as the owner would from Telegram.</p><form method="post" action="/ops/channels/reply" class="stack"><input name="address" value="${addr ?? `owner:${p.business_id}`}" required><input name="text" placeholder="message or approve:apr_…" required><button class="btn" type="submit">Send inbound</button></form>${thread.length ? html`<div class="transcript">${thread.map((m: any) => html`<div class="turn ${m.direction === "in" ? "customer" : "agent"}">${m.body}<br><small class="muted">${m.channel} · ${m.status}</small></div>`)}</div>` : ""}</div>
<div class="card"><h3>Recent messages</h3><div class="table-wrap"><table class="small"><tr><th>When</th><th>Channel</th><th>Dir</th><th>Address</th><th>Body</th><th>Status</th></tr>${msgs.map((m: any) => html`<tr><td>${fmtDate(m.created_at)}</td><td>${m.channel}</td><td>${m.direction}</td><td><a href="/ops/channels?address=${encodeURIComponent(m.address)}">${String(m.address).slice(0, 28)}</a></td><td>${String(m.body).slice(0, 90)}</td><td>${pill(m.status === "simulated" ? "warn" : m.status === "sent" ? "paid" : m.status, m.status)}</td></tr>`)}</table></div></div></div>`));
  }));
  /** One tap: a 15-minute one-time code, then straight into Telegram; the shared bot routes "callback-<code>" here. */
  r.post("/connect/telegram", act(async (req, res, p) => {
    ownerOnly(p);
    const ws = currentWs();
    const code = `${ws ? `${ws}Z` : ""}${randomBytes(12).toString("base64url").replace(/[-_]/g, "x")}`;
    await (await getDb()).query("INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [`tglink:${code}`, JSON.stringify({ business_id: p.business_id, exp: Date.now() + 15 * 60_000 })]);
    res.redirect(303, `https://t.me/${config.channels.telegramBot}?start=callback-${code}`);
  }));
  r.post("/ops/channels/reply", act(async (req, res, p) => {
    ownerOnly(p);
    const reply = await receive("simulator", String(req.body.address), String(req.body.text ?? ""), null, null);
    const { drainAll } = await import("../worker.js");
    await drainAll(await getDb());
    back(res, `/ops/channels?address=${encodeURIComponent(String(req.body.address))}`, reply ? `Reply: ${reply.slice(0, 120)}` : "Received (no reply).");
  }));
  r.post("/webhooks/telegram", page(async (req, res) => {
    if (config.channels.telegramSecret && req.get("x-telegram-bot-api-secret-token") !== config.channels.telegramSecret) return res.status(403).end();
    // A chat linked from a private demo is answered inside that demo; the link code or the customer token names it.
    await routeTelegram(req.body ?? {}, async (u: any) => {
      const chat = String(u?.message?.chat?.id ?? u?.callback_query?.message?.chat?.id ?? u?.callback_query?.from?.id ?? "");
      const start = /^\/start\s+(\S+)/.exec(String(u?.message?.text ?? ""));
      let ws = start ? wsFromSecret(start[1]) : null;
      if (!ws && chat) ws = await wsForRef(`tg:${chat}`);
      if (ws && !(await getWorkspace(ws))) ws = null;
      return inWorkspace(ws, () => telegramUpdate(u));
    });
    res.json({ ok: true });
  }));
  r.get("/webhooks/whatsapp", (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === config.channels.whatsappVerifyToken) return res.send(String(req.query["hub.challenge"]));
    res.status(403).end();
  });
  r.post("/webhooks/whatsapp", page(async (req, res) => {
    await whatsappUpdate(req.body ?? {});
    res.json({ ok: true });
  }));
  r.post("/webhooks/sms", page(async (req, res) => {
    // Same check as the voice webhooks: a Twilio signature (or the URL secret). Without it anyone could post a fake
    // "STOP" or a fake owner message here.
    const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    if (!webhookAuthorised(url, req.body ?? {}, req.get("x-twilio-signature") ?? undefined, typeof req.query.s === "string" ? req.query.s : undefined)) return res.status(403).end();
    await smsUpdate(req.body ?? {});
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  }));

  /* ---------------- PWA (B.8) ---------------- */
  r.get("/manifest.webmanifest", (_req, res) => res.type("application/manifest+json").json({ name: "Callback", short_name: "Callback", start_url: "/today", display: "standalone", background_color: "#f4f1ea", theme_color: "#0e5a53", icons: [{ src: "/static/icon.svg", sizes: "any", type: "image/svg+xml" }] }));
  r.get("/sw.js", (_req, res) => res.type("application/javascript").send(readFileSync(join(root, "public", "sw.js"), "utf8")));
  r.get("/push/public-key", (_req, res) => res.json({ key: config.channels.vapidPublic || null }));
  r.post("/push/subscribe", json(async (req) => {
    const p = await me(req);
    if (!p) throw new GtError("Sign in first", "unauthorized", 401);
    await subscribe("owner", p.business_id, req.body);
    return { subscribed: true, live: pushReady() };
  }));

  /* ---------------- evidence (B.10) ---------------- */
  r.get("/ops/evidence", authed(async (req, res, p) => {
    ownerOnly(p);
    const db = await getDb();
    const ai = await aiUsageSummary();
    const chain = await verifyChain(db);
    const pol = await activePolicy(p.business_id, db);
    const bt = backtest(await history(p.business_id, db), pol.rules, await guardSettings(p.business_id, db));
    const sums = { personas: await summarise("personas"), adversarial: await summarise("adversarial") };
    const calls = await callsOf(db, p.business_id, { status: ["ended"], limit: 500 });
    const counts = (await db.query<{ t: string; n: string }>("SELECT 'runs' AS t, count(*)::text AS n FROM agent_runs UNION ALL SELECT 'steps', count(*)::text FROM agent_trace UNION ALL SELECT 'paypal_steps', count(*)::text FROM agent_trace WHERE actor = 'paypal' UNION ALL SELECT 'blocked', count(*)::text FROM agent_trace WHERE gate IN ('denied','held','dry_run_refused') UNION ALL SELECT 'approvals', count(*)::text FROM approvals UNION ALL SELECT 'quarantined', count(*)::text FROM events WHERE type = 'speech.quarantined'")).rows;
    const n = (t: string) => Number(counts.find((c) => c.t === t)?.n ?? 0);
    res.send(await ownerPage(req, p, "Evidence", html`<h1>Evidence</h1><p class="muted">What this build can show, in numbers it produced itself.</p>
<div class="scorecard">${stat("Calls ended", calls.length)}${stat("Collected", money(calls.reduce((s, c) => s + c.collected_cents, 0)))}${stat("Guard refusals on calls", calls.reduce((s, c) => s + c.breaches, 0), "attempts stopped before PayPal")}${stat("Quarantined lines", n("quarantined"))}${stat("Trace steps", n("steps"), `${n("runs")} runs, ${n("paypal_steps")} PayPal calls, ${n("blocked")} blocked`)}${stat("Audit chain", chain.ok ? "intact" : "BROKEN", `${chain.rows} rows`)}</div>
<div class="grid2"><div class="card"><h3>Model</h3><p>${providerLabel()}. ${ai.calls} calls, ${ai.ok} ok, $${ai.cost_usd.toFixed(4)}.</p><table class="small"><tr><th>Purpose</th><th>Calls</th><th>Cost</th><th>p50 ms</th><th>Replayed</th></tr>${ai.by_purpose.map((b) => html`<tr><td>${b.purpose}</td><td>${b.calls}</td><td>$${b.cost_usd.toFixed(4)}</td><td>${b.p50_ms}</td><td>${b.replayed}</td></tr>`)}</table><p class="small muted">Model output schemas carry no amount, percentage, phone or PayPal id field (assertSafeSchema, checked at every call and by the structural test). ${hasOpenAI() ? "Cost figures are estimates from list prices." : "No AI model is configured here, so calls and policy reading show an error instead of running."}</p></div>
<div class="card"><h3>Policy backtest (active policy)</h3>${rulesTable(pol.rules)}<p>${bt.cases} by-hand calls: run ${bt.run}, wait ${bt.wait}, deny ${bt.deny}; ${money(bt.collected_auto_cents)} collected alone; ${Math.round(bt.minutes_saved / 60 * 10) / 10} h saved; ${bt.breaches_prevented} calls outside hours or consent prevented.</p></div></div>
<div class="grid2"><div class="card"><h3>Personas</h3>${sums.personas.length ? html`<table class="small"><tr><th>Arm</th><th>Cases</th><th>Clean</th><th>Traps caught</th><th>Naive $</th><th>Ours $</th></tr>${sums.personas.map((s) => html`<tr><td>${s.arm}</td><td>${s.cases}</td><td>${s.correct}</td><td>${s.traps_caught}/${s.traps}</td><td>${s.naive_usd.toFixed(2)}</td><td>${s.ours_usd.toFixed(2)}</td></tr>`)}</table>` : html`<p class="muted">Not run. <a href="/ops/eval">Run on the Evals page.</a></p>`}</div>
<div class="card"><h3>Adversarial</h3>${sums.adversarial.length ? html`<p>${sums.adversarial[0].correct}/${sums.adversarial[0].cases} attacks blocked.</p>` : html`<p class="muted">Not run. <a href="/ops/eval?suite=adversarial">Run on the Evals page.</a></p>`}<p class="small muted">Integrations: PayPal ${paypalConfigured() ? "sandbox" : "not configured"} · Twilio ${telephonyReady() ? "set" : "simulated"} · Realtime ${realtimeReady() ? "set" : "off"} · Telegram ${telegramReady() ? "set" : "simulated"} · Push ${pushReady() ? "set" : "simulated"}.</p></div></div>
<p class="small"><a href="/llms.txt">llms.txt</a> · <a href="/skill.md">skill.md</a> · <a href="/ops/mcp">MCP</a></p>`));
  }));

  /* ---------------- judge mode (B.10) ---------------- */
  r.get("/judge", page(async (req, res) => {
    const db = await getDb();
    let sid = req.cookies?.cb_judge as string | undefined;
    if (!sid) {
      sid = newId("judge");
      await db.query("INSERT INTO judge_sessions (id) VALUES ($1)", [sid]);
      res.cookie("cb_judge", sid, { httpOnly: true, sameSite: "lax", maxAge: 864e5, path: "/" });
    } else await db.query("UPDATE judge_sessions SET last_seen = now() WHERE id = $1", [sid]);
    const beat = Math.max(0, Math.min(4, Number(req.query.beat ?? 0) || 0));
    await db.query("UPDATE judge_sessions SET beat = $2 WHERE id = $1", [sid, beat]);
    const biz = await firstBiz(db);
    const owner = biz ? (await db.query<{ id: string; name: string }>("SELECT id, name FROM people WHERE business_id = $1 AND role = 'owner'", [biz.id])).rows[0] : null;
    const beats = [
      { title: "The plan, and what is refused", body: html`<p>Callback reads the records and PayPal: deposits unpaid before tomorrow, invoices past the grace, a cancelled class. Before any call is planned, code checks consent, do-not-call and local calling hours in the <em>customer's</em> time zone. Noor has no consent and is never dialled; Sam is do-not-call; Dev is travelling on London time, where it is 2 a.m. Each refusal is a line on Today with its reason.</p><p class="small muted">Where: <code>/today</code> (sign in from <a href="/demo">Demo</a>), <code>src/core/consent.ts</code>, <code>src/services/planner.ts</code>.</p>` },
      { title: "A haggler on the phone", body: html`<p>Tom asks for 30% off, then says the owner promised half price. The line is quarantined before it reaches the brain; the brain can only pick a discount step code computed from the policy (5% or 10%); 25% is not an option so it cannot be said. The pay link that follows is for the balance in the records. Every turn is a trace step.</p><p class="small muted">Where: Demo page → Run a scripted customer (haggler-chase_invoice-3), then the call page's Trace. <code>src/ai/agent.ts</code>, <code>src/core/plans.ts</code>, <code>src/ai/grounding.ts</code>.</p>` },
      { title: "The hold and the owner's approval", body: html`<p>Harbour Dental owes $420 and the owner lets the agent send links up to $300 alone. The gate holds the move, the agent says so on the call, the owner gets Approve and Decline on Telegram (or on Today), and above $200 a passkey countersign over the exact payload hash is required. The agent's retry carries the approval.</p><p class="small muted">Where: <code>/ops/guard</code>, <code>src/guard/dryrun.ts</code>, <code>src/guard/passkey.ts</code>.</p>${config.demoMode ? html`<form method="post" action="/demo/call-again" class="inline"><input type="hidden" name="name" value="Harbour"><button class="btn small" type="submit">Open Harbour Dental\'s call (signed in as the owner)</button></form>` : ""}` },
      { title: "The policy backtest", body: html`<p>The owner writes the policy in plain words. It compiles to rules the gate enforces (hours clamped to 08:00–21:00, consent never overridable), says what it could not express, and replays 90 days of calls the owner made by hand: how many Callback would run alone, hold, or refuse, the money, the hours saved. Earned autonomy proposes limits only from the owner's own approvals.</p><p class="small muted">Where: <code>/policy</code>, <code>src/guard/policy.ts</code>, <code>src/guard/backtest.ts</code>.</p>` },
      { title: "The evidence", body: html`<p>60 scripted customers against the rules brain, the model brain and an oracle; 25 attacks against the gate; the audit chain; model cost per purpose. All generated by this build on demand, exportable as CSV and Markdown. MCP servers expose the same tools to another agent with the same gate.</p><p class="small muted">Where: <code>/ops/evidence</code>, <code>/ops/eval</code>, <code>/mcp</code>, <code>/llms.txt</code>.</p>` },
    ];
    res.send(layout({ title: "Judge mode", flash: flashOf(req) }, html`<h1>Judge mode</h1><p class="muted">Five beats, under five minutes. ${owner ? html`${config.demoMode ? html`<form method="post" action="/demo/signin-as" class="inline"><button class="btn small primary" name="role" value="owner" type="submit">Sign in as the owner (${owner.name})</button></form>` : html`Sign in as the owner from the <a href="/demo">Demo page</a> (owner ${owner.name}).`}` : html`<a href="/demo">Seed the demo first.</a>`}</p>
<ol class="steps">${beats.map((b, i) => html`<li class="${i === beat ? "current" : ""}"><a href="/judge?beat=${i}">${b.title}</a></li>`)}</ol>
<div class="card"><h2>${beats[beat].title}</h2>${beats[beat].body}<p>${beat > 0 ? html`<a class="btn" href="/judge?beat=${beat - 1}">Back</a> ` : ""}${beat < 4 ? html`<a class="btn primary" href="/judge?beat=${beat + 1}">Next</a>` : html`<a class="btn primary" href="/demo">Open the demo</a>`}</p></div>`));
  }));

  /* ---------------- llms.txt, skill.md, MCP (B.3) ---------------- */
  r.get("/llms.txt", (_req, res) => res.type("text/plain").send(`# Callback
> The voice agent that makes a small business's money calls (deposits, overdue invoices, cancelled classes) inside the owner's rules, with PayPal doing the money. Amounts come from the records, never from the conversation.

## For agents
- Owner MCP: POST ${config.appUrl}/mcp with Authorization: Bearer <owner key> (stateless Streamable HTTP). Tools: get_plan, list_due, list_calls, get_call, place_call, skip_call, list_customers, customer_record, consent_record, get_policy, draft_policy, list_approvals, decide_approval, get_guard, get_trace, recent_events, list_policies. Read tools carry readOnlyHint.
- Customer MCP: POST ${config.appUrl}/c/<token>/mcp. Tools: my_account, get_pay_link, callback_slots, stop_calls.
- Skill: ${config.appUrl}/skill.md
- Traces: GET /api/v1/runs/:id (owner), /trace/:id (page).

## Guarantees
- Consent, do-not-call and local calling hours (08:00–21:00 floor, narrowed by the owner) are enforced in code before dialling.
- Every money move passes a dry-run gate (kill switches, integer money, provenance, policy, live PayPal state, autonomy limits) and is recorded on a trace before PayPal is called.
- Model output schemas have no amount, percentage, phone or PayPal id fields.
`));
  r.get("/skill.md", (_req, res) => res.type("text/markdown").send(readFileSync(join(root, "skill", "SKILL.md"), "utf8").replaceAll("{APP_URL}", config.appUrl)));
  r.get("/ops/mcp", authed(async (req, res, p) => {
    res.send(await ownerPage(req, p, "MCP", html`<h1>MCP</h1><p class="muted">Two stateless Streamable HTTP servers. Each tool runs under a run with the agent id (X-Agent-Id header); money moves pass the same gate as the UI.</p>
<div class="card"><h3>Owner server</h3><pre>POST ${config.appUrl}/mcp
Authorization: Bearer &lt;owner key&gt;
X-Agent-Id: my-agent</pre><p class="small">Tools: get_plan, list_calls, get_call, place_call, skip_call, list_customers, get_policy, draft_policy, list_approvals, decide_approval, get_guard, get_trace, recent_events, list_policies.</p></div>
<div class="card"><h3>Customer server</h3><pre>POST ${config.appUrl}/c/&lt;token&gt;/mcp</pre><p class="small">Tools: my_account, get_pay_link (their own request: never held), callback_slots, stop_calls (revokes consent immediately).</p></div>
<p class="small"><a href="/llms.txt">llms.txt</a> · <a href="/skill.md">skill.md</a></p>`));
  }));
  r.all("/mcp", async (req, res) => {
    const auth = req.get("authorization") ?? "";
    const key = auth.replace(/^Bearer\s+/i, "").trim();
    const { personByKey } = await import("./auth.js");
    const p = key ? await personByKey(key) : await me(req);
    if (!p || p.role !== "owner") return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Owner key required (Authorization: Bearer <key>)" }, id: null });
    await serveMcp(req, res, () => buildOwnerServer(p.business_id, agentIdOf(req)));
  });
  r.all("/c/:token/mcp", async (req, res) => {
    const db = await getDb();
    const c = await customerByToken(db, req.params.token).catch(() => null);
    if (!c) return res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "No such customer link" }, id: null });
    await serveMcp(req, res, () => buildCustomerServer(c, agentIdOf(req)));
  });

  return r;
}

function writeReport(name: string, md: string) {
  try {
    mkdirSync(join(root, "eval"), { recursive: true });
    writeFileSync(join(root, "eval", name), md);
  } catch { /* read-only deploys */ }
}

export { esc, raw };
export type { Request };
