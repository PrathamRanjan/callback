/**
 * The pages a judge reads without signing in (spec A3.1, A3.2, A5.6). Everything here is read at request time from
 * the app's configuration, the showcase studio, the visitor's own private demo (if they have one) or the committed
 * evaluation files. Nothing is typed by hand as "live"; a row says "simulated" unless the configuration proves otherwise.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Router, type Request } from "express";
import QRCode from "qrcode";
import { brainKind, providerLabel } from "../ai/provider.js";
import { decisionsAvailable, thresholds } from "../ai/decisions.js";
import { maskEmails } from "../agent/ask.js";
import { pushReady } from "../channels/push.js";
import { smsReady, telegramReady, whatsappReady } from "../channels/index.js";
import { config } from "../config.js";
import { getDb, inWorkspace } from "../db.js";
import { guardSettings } from "../guard/dryrun.js";
import { activePolicy } from "../guard/policy.js";
import { firstBiz } from "../store.js";
import { liveWorkspaces } from "../services/workspaces.js";
import { PAYPAL_MCP_READ, paypalMcpReady } from "../paypal/mcp.js";
import { paypalConfigured, tokenSeen } from "../paypal/index.js";
import { liveReady } from "../voice/live.js";
import { telephonyReady } from "../voice/telephony.js";
import { me } from "./auth.js";
import { json } from "./common.js";
import { workspaceOf } from "./workspace.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (p: string) => {
  try {
    return JSON.parse(readFileSync(join(root, p), "utf8"));
  } catch {
    return null;
  }
};

/** The 10 Nov message that the old scam check passed as clear (spec A6). */
export const NOV10_MESSAGE = "Hi, hope you're well. Just a heads up that we've moved banks, so please send this month's payment to our new PayPal: accounts.brightside@outlook.com. Thanks so much!";
export const HAGGLE_LINE = "Can you do it for less? Money's tight this month.";
export const JUDGE_ASK = "Who won't you call today, and what does each of their consent records say?";
export const AGREE_LINE = "Okay, that's fair. Send me the link and I'll pay it now.";

interface Step { key: string; title: string; detail: string; href: string | null; button: string }
interface Path { id: string; title: string; minutes: number; needs_login: false | string; steps: Step[] }

/** The live-versus-simulated table, built from configuration on every request. */
export function liveTable() {
  const pp = paypalConfigured();
  const ai = brainKind() === "model";
  const row = (piece: string, live: boolean, how: string, otherwise: string) => ({ piece, live, detail: live ? how : otherwise });
  return [
    row("PayPal Orders v2 (pay links, capture)", pp, `PayPal ${config.paypal.env} REST API`, "not configured: money moves fail and say so"),
    row("Saved demo wallet (pay with no PayPal login)", pp && Boolean(config.paypal.demoVaultToken), "a vaulted sandbox buyer; real sandbox orders and captures", "hidden: PayPal's own page still works"),
    row("PayPal Invoicing v2", pp, `PayPal ${config.paypal.env} REST API`, "not configured"),
    row("PayPal Catalog, Billing plans and Subscriptions (instalments)", pp, `PayPal ${config.paypal.env} REST API`, "not configured"),
    row("PayPal Payments v2 refunds", pp, `PayPal ${config.paypal.env} REST API`, "not configured"),
    row("PayPal webhooks (signature verified)", pp && Boolean(config.paypal.webhookId), "verified with PayPal's verify-webhook-signature", "no webhook id: status comes from read-back only"),
    row("PayPal's own MCP server (read tools, for Ask)", pp && paypalMcpReady(), `${PAYPAL_MCP_READ.length} read-only tools allowed in code`, "off: Ask says PayPal's records weren't available"),
    row("Call turns and policy reading", ai, providerLabel(), "no model: calls don't start and policy reading shows an error (no rules fallback)"),
    row("Scam check: AI reader (OpenAI Decisions)", decisionsAvailable(), `${config.ai.models.decisions}, thresholds from calibration`, "not run: the check says \"not run\" and never shows green"),
    row("Scam check: rules and place-to-pay code", true, "always on, in code", ""),
    row("Scam check: on-device model", true, "runs in the visitor's browser (MiniLM); shows \"not run\" if it can't load", ""),
    row("Ask agent (tool loop)", ai, `${providerLabel()}, at most 8 steps`, "refuses with 503: no answer is written by rules"),
    row("Live voice: talk in the browser (WebRTC) and call my phone (Twilio Media Streams)", liveReady(), config.ai.models.live, "hidden; typing is shown"),
    // In demo mode Twilio rings only numbers on the allowlist; the demo customers' numbers are always simulated.
    ...(config.demoMode
      ? [
          { piece: "Phone calls to the demo customers", live: false, detail: telephonyReady() ? (config.liveContactAllowlist.length ? `simulated: typed in the simulator. Twilio is set up and rings only ${config.liveContactAllowlist.length} allowlisted number${config.liveContactAllowlist.length === 1 ? "" : "s"}` : "simulated: typed in the simulator. Twilio is set up, but no number is allowlisted, so nothing rings") : "simulated: typed in the simulator and labelled" },
          { piece: "Texts to the demo customers", live: false, detail: smsReady() ? "simulated: mirrored to the customer's page. Twilio texts only allowlisted numbers" : "simulated: mirrored to the customer's page and labelled" },
        ]
      : [row("Phone calls", telephonyReady(), "Twilio", "simulated: typed in the simulator and labelled"), row("SMS", smsReady(), "Twilio", "simulated: mirrored to the customer's page and labelled")]),
    row("Telegram approvals", telegramReady(), `@${config.channels.telegramBot}`, "simulated and labelled on Messages"),
    row("WhatsApp approvals", whatsappReady(), "WhatsApp Cloud API", "simulated and labelled on Messages"),
    row("Web push", pushReady(), "VAPID", "off"),
    { piece: "Seeded samples (customers, three sample calls, three seed payments, one held charge)", live: false, detail: "seeded demo data in your private copy, marked Sample; the seed payments are real sandbox payments" },
    { piece: "The studio clock", live: false, detail: "each private demo has its own clock, moved only by its own +1 day control" },
  ];
}

/** Concrete screens in the visitor's own demo, so each step opens the exact page. Null until they have one. */
async function targets(req: Request) {
  const w = workspaceOf(req);
  const who = await me(req).catch(() => null);
  if (!w || !who) return null;
  const db = await getDb();
  const one = async (sql: string) => (await db.query<any>(sql, [who.business_id])).rows[0] ?? null;
  const priya = await one("SELECT c.id, cu.token FROM calls c JOIN customers cu ON cu.id = c.customer_id WHERE c.business_id = $1 AND cu.name LIKE 'Priya%' AND c.purpose = 'confirm_deposit' ORDER BY c.created_at DESC LIMIT 1");
  const blocked = await one("SELECT c.id, cu.name FROM calls c JOIN customers cu ON cu.id = c.customer_id WHERE c.business_id = $1 AND c.status = 'blocked' ORDER BY c.created_at LIMIT 1");
  return { role: who.role, priya_call: priya?.id ?? null, priya_page: priya?.token ? `/c/${priya.token}` : null, blocked_call: blocked?.id ?? null, blocked_name: blocked?.name ?? null };
}

export function judgePaths(t: Awaited<ReturnType<typeof targets>>): Path[] {
  const call = t?.priya_call ? `/calls/${t.priya_call}` : null;
  const q = encodeURIComponent;
  return [
    {
      id: "call", title: "Take the call yourself", minutes: 3, needs_login: false,
      steps: [
        { key: "call_placed", title: "Open Priya's deposit call and start it", detail: "Press Start in simulator. You play Priya; the agent's lines come from the model named on the page.", href: call, button: "Open Priya's call" },
        { key: "ai_turn", title: "Haggle", detail: `Say "${HAGGLE_LINE}" (already typed for you). The model answers; your rules decide whether any discount exists.`, href: call ? `${call}?say=${q(HAGGLE_LINE)}` : null, button: "Open with the line typed" },
        { key: "pay_link_sent", title: "Agree", detail: `Say "${AGREE_LINE}". Code checks the amount against the record and your limits, then creates a real PayPal sandbox order.`, href: call ? `${call}?say=${q(AGREE_LINE)}` : null, button: "Open with the line typed" },
        { key: "paid_from_wallet", title: "Pay from the saved wallet", detail: "On Priya's own page press Pay as the demo customer. No PayPal login: it pays from the demo's saved sandbox wallet and shows the order and capture ids PayPal returned.", href: t?.priya_page ?? null, button: "Open Priya's page" },
      ],
    },
    {
      id: "refuse", title: "Watch it refuse", minutes: 2, needs_login: false,
      steps: [
        { key: "asked_the_agent", title: "Ask who it won't call", detail: "Press Ask. The agent works through Callback's own read tools (the plan, then each consent record), and PayPal's MCP server when a question needs PayPal's records. Each tool call shows in the rail as it happens. No tool it has can move money.", href: `/ask?q=${q(JUDGE_ASK)}`, button: "Open Ask with the question typed" },
        { key: "opened_blocked_call", title: "Open a blocked call", detail: `${t?.blocked_name ? `${t.blocked_name}'s call` : "A blocked call"} names the rule that stopped it (consent, calling hours, do-not-call). Code decided; no model was asked.`, href: t?.blocked_call ? `/calls/${t.blocked_call}` : "/today", button: "Open the blocked call" },
        { key: "checked_message", title: "Check the 10 Nov scam message", detail: "A polite \"we've moved banks, pay our new PayPal\" message. It is held: it names a place to pay that isn't on file.", href: `/safety?text=${q(NOV10_MESSAGE)}`, button: "Open the check with it pasted" },
      ],
    },
    {
      id: "approve", title: "Approve a held move", minutes: 2, needs_login: false,
      steps: [
        { key: "viewed_hold", title: "Read why it stopped", detail: "A $360 charge is over the $300 limit, so it waits for you: what moves, to whom, why, and how to undo it.", href: "/approvals", button: "Open Approvals" },
        { key: "approval_decided", title: "Approve or decline it", detail: "Approving carries out the exact move whose hash you saw; declining leaves the money where it is. Both go into the hash-chained audit log.", href: "/approvals", button: "Open Approvals" },
        { key: "opened_money", title: "See what PayPal says", detail: "Money reads each move back from PayPal, so the status matches PayPal's own record.", href: "/money", button: "Open Money" },
      ],
    },
  ];
}

export const PUBLIC_PAGES = [
  { href: "/proof", title: "Proof", body: "Every evaluation case: input, expected, the model's answer, pass or fail." },
  { href: "/ai", title: "AI calls", body: "The last 20 model calls: what for, which model, latency and cost." },
  { href: "/paypal", title: "PayPal", body: "Every PayPal API the app uses, when, and a live sandbox id for each." },
  { href: "/who-can-move-money", title: "Who can move money", body: "Owner, front desk, customer, each model, outside agents: can and cannot." },
  { href: "/accessibility", title: "Accessibility", body: "What was tested, how, and what wasn't." },
  { href: "/agents", title: "For AI agents", body: "Connect an outside assistant over MCP, with a copy-paste command." },
];

/** Families of PayPal calls, in the order a call meets them, each with where the live id comes from. */
const PAYPAL_APIS: { api: string; endpoint: string; when: string; sql: string | null; label: string }[] = [
  { api: "OAuth 2.0 client credentials", endpoint: "POST /v1/oauth2/token", when: "Before any PayPal call; the token is cached until it expires.", sql: null, label: "token issued" },
  { api: "Orders v2: create", endpoint: "POST /v2/checkout/orders", when: "The customer agrees on a call (or taps Pay) and the gate allows the amount.", sql: "SELECT paypal_order_id AS id, created_at AS at FROM pay_links WHERE paypal_order_id IS NOT NULL ORDER BY created_at DESC LIMIT 1", label: "order id" },
  { api: "Orders v2: capture (incl. saved-wallet payment)", endpoint: "POST /v2/checkout/orders/{id}/capture", when: "The buyer approves, or the demo wallet pays with its vault id.", sql: "SELECT capture_id AS id, created_at AS at FROM obligations WHERE capture_id IS NOT NULL ORDER BY created_at DESC LIMIT 1", label: "capture id" },
  { api: "Invoicing v2", endpoint: "POST /v2/invoicing/invoices, …/send", when: "An overdue bill is sent as a PayPal invoice instead of a link.", sql: "SELECT paypal_invoice_id AS id, created_at AS at FROM invoices WHERE paypal_invoice_id IS NOT NULL ORDER BY created_at DESC LIMIT 1", label: "invoice id" },
  { api: "Catalog products, Billing plans, Subscriptions", endpoint: "POST /v1/catalogs/products, /v1/billing/plans, /v1/billing/subscriptions", when: "The customer picks a payment plan the rules allow.", sql: "SELECT subscription_id AS id, created_at AS at FROM instalment_plans WHERE subscription_id IS NOT NULL ORDER BY created_at DESC LIMIT 1", label: "subscription id" },
  { api: "Payments v2: refund a capture", endpoint: "POST /v2/payments/captures/{id}/refund", when: "A cancelled class is refunded to the payment it came from.", sql: "SELECT paypal_refund_id AS id, created_at AS at FROM refunds WHERE paypal_refund_id IS NOT NULL ORDER BY created_at DESC LIMIT 1", label: "refund id" },
  { api: "Webhooks: verify signature", endpoint: "POST /v1/notifications/verify-webhook-signature", when: "PayPal tells the app a payment completed; only verified events change a record.", sql: "SELECT resource_id AS id, received_at AS at, event_type FROM webhook_events WHERE verified ORDER BY received_at DESC LIMIT 1", label: "event resource id" },
  { api: "PayPal MCP server (read tools)", endpoint: "SSE https://mcp.sandbox.paypal.com/sse", when: "The Ask agent reads PayPal's own records (orders, transactions, invoices).", sql: "SELECT (result->>'name') AS id, at FROM agent_trace WHERE tool = 'ask.tool' AND actor = 'paypal' ORDER BY id DESC LIMIT 1", label: "last tool called" },
];

const roles = () => {
  const turn = config.ai.models.read;
  return [
    { who: "Owner (signed in with the owner key or the demo button)", can: ["Approve or decline held moves (passkey above the countersign amount, once one is registered)", "Change rules and limits; engage the kill switch", "Place and skip calls", "Refund within the rules"], cannot: ["Send a refund anywhere but the payment it came from", "Charge more than the record says is owed"] },
    { who: "Front desk", can: ["See calls and customers", "Run calls in the simulator"], cannot: ["Move money", "Approve held moves", "Change rules or limits"] },
    { who: "Customer (their own link)", can: ["Pay what they owe on PayPal (or the demo wallet)", "Choose a refund or credit for a cancelled class", "Pick a plan the rules offer", "Ask for a call-back or tell Callback to stop"], cannot: ["See anyone else's records", "Change an amount", "Send money anywhere new"] },
    { who: `The call model (${turn})`, can: ["Pick the next line and one tool from a fixed list", "Pick an option id that code computed"], cannot: ["Write an amount: the schema has no money field, and an amount that appears only in speech is denied", "Skip consent, calling hours or the gate"] },
    { who: `The Ask agent (${turn})`, can: ["Call Callback's read tools and PayPal's read tools", "Write a proposal row for the owner"], cannot: ["Place a call, decide an approval, change rules or move money: those tools are not given to it"] },
    { who: `The scam check (${config.ai.models.decisions})`, can: ["Answer yes/no questions about a message"], cannot: ["Clear a message on its own: green needs every reader to run and agree"] },
    { who: "An outside agent over MCP (owner Bearer key at /mcp)", can: ["Read the plan, calls, customers, rules", "Place or skip a call, draft a policy, decide an approval: each through the same gate and limits as the owner"], cannot: ["Go past the limits: big moves are held for the owner's approval like any other"] },
    { who: "An outside agent over MCP (customer link at /c/<token>/mcp)", can: ["Read that customer's own balance", "Get their PayPal pay link (the customer still pays on PayPal)", "Book a call-back time", "Stop the calls"], cannot: ["See other customers", "Change an amount or move money"] },
  ];
};

/** What a model call returned, in a few words. For another visitor's demo only tool names and numbers are shown, never text. */
function summarise(purpose: string, output: unknown, redact = false): string {
  const o = (typeof output === "string" ? (() => { try { return JSON.parse(output); } catch { return output; } })() : output) as any;
  if (!o) return "";
  if (Array.isArray(o?.calls)) return o.calls.length ? `step ${o.step}: called ${o.calls.join(", ")}` : `step ${o.step}: wrote the answer`;
  if (Array.isArray(o?.answers)) return o.answers.map((a: any) => `${a.name}: ${a.type === "refusal" ? "refused" : a.probability ?? a.value ?? a.choice ?? "?"}`).join(", ");
  if (redact) return o.tool ? `picked tool ${o.tool}` : "an answer (text not shown: another visitor's demo)";
  if (o.say) return `said: "${String(o.say).slice(0, 160)}"${o.tool ? ` · tool ${o.tool}` : ""}`;
  return maskEmails(JSON.stringify(o).slice(0, 220));
}

async function aiRows(ws: string | null, redact = false, limit = 20) {
  const db = await getDb();
  const rows = (await inWorkspace(ws, () => db.query<any>("SELECT a.id, a.purpose, a.model, a.via, a.tokens_in, a.tokens_out, a.cost_usd, a.latency_ms, a.ok, a.error, a.output, a.at, r.subject FROM ai_calls a LEFT JOIN agent_runs r ON r.id = a.run_id ORDER BY a.id DESC LIMIT $1", [limit]))).rows;
  return rows.map((r) => ({ id: `${ws ?? "s"}-${r.id}`, purpose: r.purpose, model: r.model, via: r.via, input: redact ? "" : maskEmails(String(r.subject ?? "")).slice(0, 160), output: r.ok ? summarise(r.purpose, r.output, redact) : "", error: r.error ? (redact ? "failed" : String(r.error).slice(0, 160)) : null, ok: r.ok, latency_ms: Number(r.latency_ms), tokens_in: Number(r.tokens_in), tokens_out: Number(r.tokens_out), cost_usd: Number(r.cost_usd), at: r.at }));
}
/** The latest model calls across the most recent other private demos, text hidden. */
async function recentAiRows(except: string | null) {
  const ids = (await liveWorkspaces()).map((x) => x.id).filter((id) => id !== except).slice(0, 8);
  const all = (await Promise.all(ids.map((id) => aiRows(id, true, 20).catch((e) => (console.error(`[public/ai] ${id}: ${(e as Error).message}`), []))))).flat();
  return all.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 20);
}

export function publicRouter() {
  const r = Router();

  r.get("/api/public/judge", json(async (req) => {
    const w = workspaceOf(req);
    const t = await targets(req);
    const join = w?.join_token ? `${config.appUrl}/demo/join/${w.join_token}` : null;
    const buyer = process.env.JUDGE_BUYER_EMAIL ? { email: process.env.JUDGE_BUYER_EMAIL, password: process.env.JUDGE_BUYER_PASSWORD ?? null } : null;
    return {
      app_url: config.appUrl,
      demo: config.demoMode,
      workspace: w ? { expires_at: w.expires_at, join_url: join, qr_svg: join ? await QRCode.toString(join, { type: "svg", margin: 1, errorCorrectionLevel: "M" }) : null } : null,
      signed_in_as: t?.role ?? null,
      checklist: w?.checklist ?? {},
      paths: judgePaths(t),
      live: liveTable(),
      accounts: {
        buyer,
        note: buyer ? "A sandbox buyer kept for judges, only needed for Pay on PayPal's own page. The first path needs no PayPal login." : "No PayPal login is needed for any path here: the demo pays from a saved sandbox wallet. A separate sandbox buyer for judges (for Pay on PayPal's own page) isn't set up yet.",
      },
      pages: PUBLIC_PAGES,
    };
  }));

  r.get("/api/public/proof", json(async () => {
    const ev = readJson("eval/results/ai-eval.json");
    const th = Object.values(thresholds()).map((x) => ({ name: x.name, clear_below: x.clear_below, hold_above: x.hold_above, n: x.n, precision_at_hold: x.precision_at_hold, recall_at_hold: x.recall_at_hold, calibrated_on: x.calibrated_on }));
    return { eval: ev, thresholds: th, models: { turn: config.ai.models.read, decisions: config.ai.models.decisions, label: providerLabel() }, nightly: String(ev?.runner ?? "") === "github-actions:schedule", runner: String(ev?.runner ?? "by hand"), source: "eval/results/ai-eval.json, written by npm run eval:ai (by hand) or .github/workflows/ai-eval.yml (nightly, once switched on)" };
  }));

  r.get("/api/public/ai", json(async (req) => {
    const w = workspaceOf(req);
    return { showcase: await aiRows(null), yours: w ? await aiRows(w.id) : null, recent: await recentAiRows(w?.id ?? null), models: { label: providerLabel(), decisions: config.ai.models.decisions } };
  }));

  r.get("/api/public/paypal", json(async (req) => {
    const db = await getDb();
    const w = workspaceOf(req);
    // Your own demo first, then the showcase, then the most recent other private demos (sandbox ids only; nothing
    // else from them is shown), so every API has a real id once anyone has used it.
    const others = (await liveWorkspaces()).map((x) => x.id).filter((id) => id !== w?.id).slice(0, 25);
    const order: (string | null)[] = [...(w ? [w.id] : []), null, ...others];
    // A failed read is said on the page ("couldn't read"), never shown as "none yet".
    const pick = async (sql: string | null): Promise<{ live: { id: string; at: string; where: string; extra: string | null } | null; error: boolean }> => {
      // OAuth has no id to show: the time this server last got a token stands in for it (the token is never shown).
      if (!sql) return { live: tokenSeen.at ? { id: "access token (not shown)", at: tokenSeen.at, where: "this server", extra: `${tokenSeen.scopes} scopes` } : null, error: false };
      let error = false;
      for (const ws of order) {
        const res = await inWorkspace(ws, () => db.query<any>(sql)).catch((e) => {
          console.error(`[public/paypal] ${ws ?? "showcase"}: ${(e as Error).message}`);
          error = true;
          return { rows: [] as any[] };
        });
        const row = res.rows[0];
        if (row?.id) return { live: { id: String(row.id), at: row.at, where: ws === null ? "showcase studio" : ws === w?.id ? "your demo" : "another visitor's demo", extra: row.event_type ?? null }, error: false };
      }
      return { live: null, error };
    };
    const apis = [];
    for (const a of PAYPAL_APIS) apis.push({ api: a.api, endpoint: a.endpoint, when: a.when, label: a.label, ...(await pick(a.sql)) });
    return { env: config.paypal.env, configured: paypalConfigured(), apis, mcp_tools: PAYPAL_MCP_READ };
  }));

  r.get("/api/public/facts", json(async () => {
    // The limits are read from the showcase studio's own settings and rules, as the gate reads them.
    const db = await getDb();
    const lim = await inWorkspace(null, async () => {
      const biz = await firstBiz(db);
      if (!biz) return null;
      const g = await guardSettings(biz.id, db);
      const pol = await activePolicy(biz.id, db);
      return { auto_charge_max_cents: g.auto_charge_max_cents, auto_refund_max_cents: g.auto_refund_max_cents, auto_discount_max_pct: g.auto_discount_max_pct, max_discount_pct: pol.rules.max_discount_pct, min_instalment_cents: pol.rules.min_instalment_cents, countersign_above_cents: config.guard.countersignAboveCents };
    });
    return {
      roles: roles(),
      limits: lim,
      mcp: { owner: `${config.appUrl}/mcp`, customer: `${config.appUrl}/c/<token>/mcp`, llms: `${config.appUrl}/llms.txt`, skill: `${config.appUrl}/skill.md` },
    };
  }));

  return r;
}
