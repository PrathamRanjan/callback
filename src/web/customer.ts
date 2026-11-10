import { icon } from "./icons.js";
/** Customer pages by status token: what is owed, pay now (their own click), pick a callback time, stop calls. */
import { Router } from "express";
import { config } from "../config.js";
import { callbackSlots } from "../core/plans.js";
import { fmtLocal } from "../core/time.js";
import { getDb } from "../db.js";
import { appendAudit } from "../guard/audit.js";
import { activePolicy } from "../guard/policy.js";
import { newId } from "../lib/ids.js";
import { GtError } from "../lib/util.js";
import { createPlan, payFromDemoWallet, sendPayLink, settleCancelledClass, SPLITTABLE } from "../services/money.js";
import { markStep } from "../services/workspaces.js";
import { balanceOf, owedToCustomer, bizById, customerByToken, logEvent, nowOf, obligationsOf, callsOf } from "../store.js";
import { startRun } from "../trace.js";
import { back, flashOf, page } from "./common.js";
import { html, layout, pill, raw } from "./html.js";
import { money } from "./views.js";

export function customerRouter(): Router {
  const r = Router();
  r.get("/c/:token", page(async (req, res) => {
    const db = await getDb();
    const c = await customerByToken(db, req.params.token);
    const biz = await bizById(db, c.business_id);
    const obls = await obligationsOf(db, c.business_id, c.id);
    const pol = await activePolicy(c.business_id, db);
    const slots = callbackSlots(await nowOf(db, c.business_id), c.tz, pol.rules, 6);
    const lastCall = (await callsOf(db, c.business_id, { customerId: c.id, limit: 1 }))[0];
    const msgs = (await db.query<any>("SELECT * FROM channel_messages WHERE address = $1 AND direction = 'out' ORDER BY created_at DESC LIMIT 5", [`customer:${c.token}`])).rows;
    const verify = lastCall?.state?.verify_code as string | undefined;
    const open = obls.filter((o) => !["paid", "credited", "refunded", "void"].includes(o.status));
    const done = obls.filter((o) => ["paid", "credited", "refunded"].includes(o.status));
    res.send(layout({ title: "Your account", customer: { business: biz.name }, flash: flashOf(req) }, html`<div class="page-head"><div><h1>Hi ${c.name.split(" ")[0]}</h1><p>Your account with ${biz.name}.</p></div></div>
${req.query.paid ? html`<div class="banner good" role="status">Thanks: PayPal has your payment. It shows here once confirmed.</div>` : ""}${req.query.plan ? html`<div class="banner good" role="status">Your payment plan is approved.</div>` : ""}
${verify ? html`<section class="card verify-card" id="verify"><div class="spread"><div><h2>Is it really ${biz.name} calling?</h2><p class="sub muted">Our last call gave this verify code. If a caller can't tell you this code, hang up and use this page instead.</p></div><span class="verify-code" aria-label="Verify code ${verify.split("").join(" ")}">${verify}</span></div></section>` : ""}
<div class="section-title"><h2>What's open</h2></div>
${open.length ? html`<div class="stack">${open.map((o) => o.kind === "class_cancel" ? html`<section class="card"><div class="spread"><div><h3 style="margin:0">${o.title}</h3><p class="sub muted">${o.appointment_at ? fmtLocal(o.appointment_at, c.tz) : ""}</p></div><span class="amt big-amt">${money(owedToCustomer(o))}</span></div>${owedToCustomer(o) ? html`<p>We cancelled this class, so we owe you <b>${money(owedToCustomer(o))}</b>. How would you like it?</p><form method="post" action="/c/${c.token}/settle/${o.id}" class="row"><button class="btn primary lg" type="submit" name="choice" value="refund">${raw(icon("undo"))}Refund to my PayPal</button><button class="btn lg" type="submit" name="choice" value="credit">${raw(icon("ticket"))}Keep it as a class credit</button></form><p class="small muted">${o.capture_id ? "A refund goes back to the PayPal account you paid with. It can't be sent anywhere else." : "You paid for this class outside PayPal, so a refund is paid back the same way you paid. It can't be sent anywhere else."}</p>` : html`<p class="muted">Nothing to settle.</p>`}</section>` : html`<section class="card"><div class="spread"><div><h3 style="margin:0">${o.title}</h3><p class="sub muted">${o.due_at ? `Due ${fmtLocal(o.due_at, c.tz)}` : ""}${o.appointment_at ? ` · appointment ${fmtLocal(o.appointment_at, c.tz)}` : ""}${o.discount_cents ? ` · after ${money(o.discount_cents)} off` : ""}</p></div><span class="amt big-amt">${money(balanceOf(o))}</span></div><form method="post" action="/c/${c.token}/pay/${o.id}" class="row" style="margin-top:.75rem"><button class="btn primary lg" type="submit">${raw(icon("wallet"))}Pay ${money(balanceOf(o))} on PayPal's own page</button>${pill(o.status)}</form>${config.demoMode && config.paypal.demoVaultToken ? html`<form method="post" action="/c/${c.token}/wallet/${o.id}" class="row" style="margin-top:.5rem"><button class="btn lg" type="submit">Pay as the demo customer (saved PayPal, no login)</button></form><p class="small muted">Demo only: paid from the demo's saved sandbox wallet. A real sandbox payment; nothing real is charged.</p>` : ""}</section>`)}</div>` : html`<div class="empty">Nothing outstanding. Thank you.</div>`}
${done.length ? html`<details class="card"><summary><b>Settled</b> <span class="muted small">${done.length} item${done.length === 1 ? "" : "s"}</span></summary><table class="kv">${done.map((o) => html`<tr><th>${o.title}</th><td>${pill(o.status)}</td></tr>`)}</table></details>` : ""}
${msgs.length ? html`<section class="card"><h2>Messages from ${biz.name}</h2><ul class="feed">${msgs.map((m: any) => html`<li><span class="small muted">${m.channel}</span><br>${m.body}</li>`)}</ul></section>` : ""}
<div class="grid g2" style="margin-top:1rem"><section class="card"><h2>Calls from us</h2><p class="sub muted">${c.dnc ? "You've asked not to be called. We won't." : c.consent ? `You agreed on ${c.consent.granted_at.slice(0, 10)} that we may call about your account, ${pol.rules.hours.start}–${pol.rules.hours.end} your time.` : "We have no consent on file, so we won't call you."}</p>
${!c.dnc && c.consent ? html`<form method="post" action="/c/${c.token}/callback" class="stack"><label for="cbat">Call me back at</label><select id="cbat" name="at">${slots.map((s) => html`<option value="${s.at}">${s.label}</option>`)}</select><div class="row"><button class="btn" type="submit">Book a callback</button></div></form><form method="post" action="/c/${c.token}/stop" style="margin-top:.75rem"><button class="btn ghost small" type="submit">Stop calling me</button></form>` : ""}</section>
<section class="card"><h2>Updates on your phone</h2><p class="sub muted">Get your links and receipts on Telegram, and reply “status” any time.</p><a class="btn" href="https://t.me/${config.channels.telegramBot}?start=callback-${c.token}" target="_blank" rel="noopener">${raw(icon("message"))}Get updates on Telegram</a></section></div>`));
  }));
  r.post("/c/:token/pay/:oid", page(async (req, res) => {
    const db = await getDb();
    const c = await customerByToken(db, req.params.token);
    const biz = await bizById(db, c.business_id);
    const o = (await obligationsOf(db, c.business_id, c.id)).find((x) => x.id === req.params.oid);
    if (!o) throw new GtError("Not your item", "not_found", 404);
    const run = await startRun({ actor: "customer", subject: `${c.name} asked to pay ${o.title}`, entity: "obligation", entityId: o.id }, db);
    try {
      const out = await sendPayLink({ q: db, run, businessId: biz.id, businessName: biz.name, callId: null, agentScope: `customer:${c.id}`, personInitiated: true }, o, c);
      await run.end("done");
      if (out.approveUrl && !out.approveUrl.includes("fake.paypal.local")) return res.redirect(out.approveUrl);
      back(res, `/c/${c.token}`, `PayPal link created for ${money(out.cents)} (sandbox: ${out.approveUrl ?? "see messages"}).`);
    } catch (e) {
      await run.end("failed");
      throw e;
    }
  }, (req) => `/c/${req.params.token}`));
  /** Demo only (spec A2.1): pay from the demo's saved sandbox wallet, no PayPal login. Real order and capture ids. */
  r.post("/c/:token/wallet/:oid", page(async (req, res) => {
    const db = await getDb();
    const c = await customerByToken(db, req.params.token);
    const biz = await bizById(db, c.business_id);
    const o = (await obligationsOf(db, c.business_id, c.id)).find((x) => x.id === req.params.oid);
    if (!o || o.kind === "class_cancel") throw new GtError("Not your item", "not_found", 404);
    const run = await startRun({ actor: "customer", subject: `${c.name} paid ${o.title} from the saved demo wallet`, entity: "obligation", entityId: o.id }, db);
    try {
      const out = await payFromDemoWallet({ q: db, run, businessId: biz.id, businessName: biz.name, callId: null, agentScope: `customer:${c.id}`, personInitiated: true }, o, c);
      await run.end("done");
      await markStep("paid_from_wallet");
      back(res, `/c/${c.token}`, `Paid ${money(out.cents)} from the demo's saved sandbox wallet. PayPal order ${out.orderId}, capture ${out.captureId}, read back from PayPal.`);
    } catch (e) {
      await run.end("failed");
      throw e;
    }
  }, (req) => `/c/${req.params.token}`));
  r.post("/c/:token/settle/:oid", page(async (req, res) => {
    const db = await getDb();
    const c = await customerByToken(db, req.params.token);
    const biz = await bizById(db, c.business_id);
    const o = (await obligationsOf(db, c.business_id, c.id)).find((x) => x.id === req.params.oid);
    if (!o || o.kind !== "class_cancel") throw new GtError("Not your item", "not_found", 404);
    const choice = req.body.choice === "refund" ? "refund" : "credit";
    const run = await startRun({ actor: "customer", subject: `${c.name} chose a ${choice} for ${o.title}`, entity: "obligation", entityId: o.id }, db);
    try {
      const out = await settleCancelledClass({ q: db, run, businessId: biz.id, businessName: biz.name, callId: null, agentScope: `customer:${c.id}`, personInitiated: true }, o, choice);
      await run.end("done");
      back(res, `/c/${c.token}`, out.choice === "refund" ? (out.refundId ? `Refund of ${money(out.cents)} sent to the PayPal account you paid with.` : `Refund of ${money(out.cents)} recorded. You paid for this class outside PayPal, so ${biz.name} will pay it back the same way.`) : `${money(out.cents)} is now a class credit on your account.`);
    } catch (e) {
      await run.end("failed");
      throw e;
    }
  }, (req) => `/c/${req.params.token}`));
  /** The customer splits an open invoice into one of the plans the owner's rules allow. The gate checks it; PayPal opens to approve. */
  r.post("/c/:token/plan/:oid", page(async (req, res) => {
    const db = await getDb();
    const c = await customerByToken(db, req.params.token);
    const biz = await bizById(db, c.business_id);
    const o = (await obligationsOf(db, c.business_id, c.id)).find((x) => x.id === req.params.oid);
    if (!o || o.kind !== "invoice") throw new GtError("Not your item", "not_found", 404);
    if (!SPLITTABLE.has(o.status)) throw new GtError("This one already has a payment plan or a PayPal invoice, or is settled.", "not_open");
    const option = String(req.body.option ?? "");
    if (!option) throw new GtError("Pick a plan.", "no_option");
    const run = await startRun({ actor: "customer", subject: `${c.name} asked to split ${o.title}`, entity: "obligation", entityId: o.id }, db);
    try {
      const out = await createPlan({ q: db, run, businessId: biz.id, businessName: biz.name, callId: null, agentScope: `customer:${c.id}`, personInitiated: true }, o, c, option);
      await run.end("done");
      if (out.approveUrl && !out.approveUrl.includes("fake.paypal.local")) return res.redirect(out.approveUrl);
      back(res, `/c/${c.token}`, `Plan ready: ${out.option.label}. Approve it with PayPal from the link we texted you.`);
    } catch (e) {
      await run.end("failed");
      throw e;
    }
  }, (req) => `/c/${req.params.token}`));
  r.post("/c/:token/stop", page(async (req, res) => {
    const db = await getDb();
    const c = await customerByToken(db, req.params.token);
    await db.query("UPDATE customers SET dnc = true, consent = jsonb_set(coalesce(consent, '{}'::jsonb), '{revoked_at}', to_jsonb(now()::text)) WHERE id = $1", [c.id]);
    await appendAudit("consent.revoked", "customer", c.id, { by: "customer page" });
    await logEvent(db, { businessId: c.business_id, customerId: c.id, type: "consent.revoked", summary: `${c.name} asked to stop calls from their page`, actor: "customer" });
    back(res, `/c/${c.token}`, "Done. You will not be called.");
  }));
  r.post("/c/:token/callback", page(async (req, res) => {
    const db = await getDb();
    const c = await customerByToken(db, req.params.token);
    if (c.dnc || !c.consent || c.consent.revoked_at) throw new GtError("Calls are off for your account.", "no_consent");
    const at = new Date(String(req.body.at));
    if (Number.isNaN(at.getTime())) throw new GtError("Pick a time.", "bad_time");
    const open = (await db.query<{ id: string }>("SELECT id FROM calls WHERE customer_id = $1 AND status IN ('planned','blocked') ORDER BY created_at DESC LIMIT 1", [c.id])).rows[0];
    if (open) await db.query("UPDATE calls SET scheduled_at = $2, reason = reason || ' · callback requested by customer' WHERE id = $1", [open.id, at.toISOString()]);
    else await db.query("INSERT INTO callbacks (id, business_id, call_id, customer_id, at) SELECT $1, $2, id, $3, $4 FROM calls WHERE customer_id = $3 ORDER BY created_at DESC LIMIT 1", [newId("cbk"), c.business_id, c.id, at.toISOString()]);
    await logEvent(db, { businessId: c.business_id, customerId: c.id, type: "callback.requested", summary: `${c.name} asked for a callback ${fmtLocal(at, c.tz)}`, actor: "customer" });
    back(res, `/c/${c.token}`, `We'll call ${fmtLocal(at, c.tz)}.`);
  }, (req) => `/c/${req.params.token}`));
  return r;
}

export const appUrl = config.appUrl;
