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
import { sendPayLink } from "../services/money.js";
import { balanceOf, bizById, customerByToken, logEvent, nowOf, obligationsOf, callsOf } from "../store.js";
import { startRun } from "../trace.js";
import { back, flashOf, page } from "./common.js";
import { html, layout, pill } from "./html.js";
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
    res.send(layout({ title: "Your account", customer: { business: biz.name }, flash: flashOf(req) }, html`<h1>Hi ${c.name.split(" ")[0]}</h1>
${req.query.paid ? html`<div class="banner good">Thanks: PayPal has your payment. It shows here once confirmed.</div>` : ""}${req.query.plan ? html`<div class="banner good">Your payment plan is approved.</div>` : ""}
<div class="card"><h3>Your account with ${biz.name}</h3><table><tr><th>Item</th><th>Balance</th><th>Status</th><th></th></tr>${obls.map((o) => html`<tr><td>${o.title}${o.appointment_at ? html`<br><small class="muted">${fmtLocal(o.appointment_at, c.tz)}</small>` : ""}${o.due_at ? html`<br><small class="muted">due ${fmtLocal(o.due_at, c.tz)}</small>` : ""}</td><td>${money(o.kind === "class_cancel" ? o.settled_cents : balanceOf(o))}${o.discount_cents ? html` <small class="muted">(after ${money(o.discount_cents)} off)</small>` : ""}</td><td>${pill(o.status)}</td><td>${o.kind !== "class_cancel" && balanceOf(o) > 0 && !["paid", "void"].includes(o.status) ? html`<form method="post" action="/c/${c.token}/pay/${o.id}" class="inline"><button class="btn primary small" type="submit">Pay with PayPal</button></form>` : ""}</td></tr>`)}</table>${obls.length ? "" : html`<div class="empty">Nothing outstanding.</div>`}</div>
${msgs.length ? html`<div class="card"><h3>Messages from ${biz.name}</h3><ul class="feed">${msgs.map((m: any) => html`<li><span class="small muted">${m.channel} · ${m.status}</span><br>${m.body}</li>`)}</ul></div>` : ""}
<div class="grid2"><div class="card"><h3>Calls</h3><p class="small muted">${c.dnc ? "You have asked not to be called." : c.consent ? `You agreed on ${c.consent.granted_at.slice(0, 10)} (${c.consent.source}) that ${biz.name} may call you about your account, ${pol.rules.hours.start}–${pol.rules.hours.end} your time.` : "No consent on file: you will not be called."}</p>${lastCall ? html`<p class="small">Last call: ${lastCall.status}${lastCall.outcome ? `, ${lastCall.outcome.replace(/_/g, " ")}` : ""}.</p>` : ""}
${!c.dnc ? html`<form method="post" action="/c/${c.token}/stop"><button class="btn" type="submit">Stop calling me</button></form>` : ""}</div>
<div class="card"><h3>Call me back instead</h3><form method="post" action="/c/${c.token}/callback" class="stack"><select name="at">${slots.map((s) => html`<option value="${s.at}">${s.label}</option>`)}</select><button class="btn" type="submit" ${c.dnc || !c.consent ? "disabled" : ""}>Book a callback</button></form></div></div>
<p class="small muted">Payments are handled by PayPal. ${biz.name} never asks for card details by phone.</p>`));
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
