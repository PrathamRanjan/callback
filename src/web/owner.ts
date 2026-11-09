/** Owner pages: home, sign in, Today (the plan), customers, the call policy editor with backtest and scorecard. */
import { Router } from "express";
import { fmtLocal } from "../core/time.js";
import { getDb } from "../db.js";
import { backtest, history, suggestAutonomy } from "../guard/backtest.js";
import { guardSettings } from "../guard/dryrun.js";
import { activePolicy, compilePolicy, listPolicies, savePolicy, type Rules } from "../guard/policy.js";
import { appendAudit } from "../guard/audit.js";
import { GtError } from "../lib/util.js";
import { candidates, planCalls } from "../services/planner.js";
import { balanceOf, callsOf, customerById, customersOf, eventsOf, logEvent, nowOf, obligationsOf } from "../store.js";
import { act, authed, me, ownerOnly, personByKey, signIn, signOut } from "./auth.js";
import { back, flashOf, page } from "./common.js";
import { fmtDate, html, layout, pill, raw } from "./html.js";
import { money, ownerPage, purposeLabel, stat } from "./views.js";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function rulesTable(r: Rules) {
  return html`<table class="kv">
<tr><th>Purposes</th><td>${r.purposes.map((p) => purposeLabel[p]).join(", ") || "none"}</td></tr>
<tr><th>Calling hours</th><td>${r.hours.start}–${r.hours.end} local to the customer, ${r.days.map((d) => DAYS[d]).join(" ")} <span class="muted small">(statutory floor 08:00–21:00 cannot be widened)</span></td></tr>
<tr><th>Attempts</th><td>${r.max_attempts_per_day}/day, ${r.cooldown_hours} h between</td></tr>
<tr><th>Discount</th><td>up to ${r.max_discount_pct}%</td></tr>
<tr><th>Instalments</th><td>up to ${r.max_instalments}, at least ${money(r.min_instalment_cents)} each</td></tr>
<tr><th>Alone up to</th><td>${money(r.auto_charge_max_cents)} per link or invoice; refunds ${money(r.auto_refund_max_cents)}</td></tr>
<tr><th>Consent</th><td>always required, never overridable</td></tr></table>`;
}

export function ownerRouter(): Router {
  const r = Router();

  r.get("/", page(async (req, res) => {
    const p = await me(req);
    if (p) return res.redirect("/today");
    res.send(layout({ title: "Callback", flash: flashOf(req) }, html`
<section class="hero"><h1>Callback</h1><p class="lead">The voice agent that makes a small business's money calls: tomorrow's deposits, overdue invoices, cancelled classes. It speaks inside the owner's rules; PayPal does the money; every amount comes from the records, never from the conversation.</p>
<p><a class="btn primary" href="/login">Owner sign in</a> <a class="btn" href="/judge">Judge mode (5 min)</a> <a class="btn" href="/demo">Demo controls</a></p></section>
<div class="grid3">
<div class="card"><h3>Who to call</h3><p>The planner reads the records and PayPal: deposits unpaid before tomorrow, invoices past the grace, classes cancelled. Consent, do-not-call and local calling hours are checked in code before anything rings.</p></div>
<div class="card"><h3>What it may do</h3><p>Text a PayPal link, send an invoice, offer an instalment plan or a discount step the owner's policy allows, book a callback. Anything larger is held for the owner, who approves with a tap or a passkey.</p></div>
<div class="card"><h3>Proof</h3><p>Every call is a trace: each line, each tool, each gate decision, each PayPal request id. 60 scripted customers and 25 attacks run on demand on the Evals page.</p></div></div>`));
  }));

  r.get("/login", page(async (req, res) => {
    res.send(layout({ title: "Sign in", flash: flashOf(req) }, html`<div class="card narrow"><h1>Sign in</h1><p class="muted">Paste the owner or staff key printed by <code>npm run seed</code>, or use the demo page.</p>
<form method="post" action="/login"><input type="hidden" name="next" value="${typeof req.query.next === "string" ? req.query.next : "/today"}"><label>Access key<input name="key" required autocomplete="off"></label><button class="btn primary" type="submit">Sign in</button></form></div>`));
  }));
  r.post("/login", page(async (req, res) => {
    const p = await personByKey(String(req.body.key ?? ""));
    if (!p) throw new GtError("That key is not recognised.", "bad_key");
    signIn(res, p, req.secure);
    const next = String(req.body.next ?? "/today");
    res.redirect(next.startsWith("/") ? next : "/today");
  }, () => "/login"));
  r.post("/logout", (_req, res) => {
    signOut(res);
    res.redirect("/");
  });

  /* ---------------- Today ---------------- */
  r.get("/today", authed(async (req, res, p) => {
    const db = await getDb();
    const now = await nowOf(db, p.business_id);
    const biz = (await db.query<{ tz: string }>("SELECT tz FROM businesses WHERE id = $1", [p.business_id])).rows[0];
    const cands = await candidates(db, p.business_id, now);
    const calls = await callsOf(db, p.business_id, { limit: 300 });
    const open = calls.filter((c) => ["planned", "blocked", "in_progress", "ringing"].includes(c.status));
    const ended = calls.filter((c) => c.status === "ended");
    const today = ended.filter((c) => c.ended_at && Date.now() - new Date(c.ended_at).getTime() < 86400_000);
    const collected = today.reduce((s, c) => s + c.collected_cents, 0);
    const pending = Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM approvals WHERE status = 'pending'")).rows[0].n);
    const custs = new Map((await customersOf(db, p.business_id)).map((c) => [c.id, c]));
    const obls = new Map((await obligationsOf(db, p.business_id)).map((o) => [o.id, o]));
    res.send(await ownerPage(req, p, "Today", html`
<h1>Today</h1><p class="muted">${fmtLocal(now, biz.tz)} in ${biz.tz}. The planner runs every few seconds; this is what it would call now, and what it refuses to.</p>
<div class="scorecard">${stat("Will call", cands.filter((c) => c.verdict.ok).length)}${stat("Not calling", cands.filter((c) => !c.verdict.ok).length, "consent or hours")}${stat("Open calls", open.length)}${stat("Collected (24 h)", money(collected))}${stat("Held for you", pending, pending ? "see Guard" : "")}</div>
${p.role === "owner" ? html`<form method="post" action="/today/plan" class="inline"><button class="btn" type="submit">Plan now</button></form>` : ""}
<div class="card"><h2>Calls</h2><div class="table-wrap"><table><tr><th>Customer</th><th>Purpose</th><th>Why</th><th>Status</th><th>When</th><th></th></tr>
${open.length ? open.map((c) => { const cu = custs.get(c.customer_id); const o = c.obligation_id ? obls.get(c.obligation_id) : null; return html`<tr><td><a href="/customers/${c.customer_id}">${cu?.name ?? "?"}</a><br><small class="muted">${cu?.tz}</small></td><td>${purposeLabel[c.purpose]}<br><small class="muted">${o?.title ?? ""} ${o ? money(balanceOf(o)) : ""}</small></td><td class="small">${c.reason}</td><td>${pill(c.status)}</td><td class="small">${c.scheduled_at ? fmtLocal(c.scheduled_at, cu?.tz ?? biz.tz) : ""}</td><td><a class="btn small" href="/calls/${c.id}">Open</a></td></tr>`; }) : html`<tr><td colspan="6" class="empty">Nothing to call. Press Plan now or use the Demo page to move the clock.</td></tr>`}
</table></div></div>
<div class="card"><h2>Recent outcomes</h2><div class="table-wrap"><table><tr><th>Ended</th><th>Customer</th><th>Purpose</th><th>Outcome</th><th>Collected</th><th>Discount</th><th>Guard refusals</th><th></th></tr>
${ended.slice(0, 15).map((c) => html`<tr><td class="small">${fmtDate(c.ended_at)}</td><td>${custs.get(c.customer_id)?.name}</td><td>${purposeLabel[c.purpose]}</td><td>${c.outcome ? pill(c.outcome === "do_not_call" ? "declined" : "ended", String(c.outcome).replace(/_/g, " ")) : ""}</td><td>${money(c.collected_cents)}</td><td>${c.discount_cents ? money(c.discount_cents) : "—"}</td><td>${c.breaches ? html`<span class="pill warn">${c.breaches}</span>` : "0"}</td><td><a class="btn small" href="/calls/${c.id}">Transcript</a></td></tr>`)}
</table></div>${ended.length ? "" : html`<div class="empty">No calls yet.</div>`}</div>`));
  }));
  r.post("/today/plan", act(async (req, res, p) => {
    ownerOnly(p);
    const db = await getDb();
    const out = await planCalls(db, p.business_id, p.name);
    back(res, "/today", `Planned ${out.planned}, blocked ${out.blocked}, unchanged ${out.skipped}. Trace ${out.runId}.`);
  }));

  /* ---------------- Customers ---------------- */
  r.get("/customers", authed(async (req, res, p) => {
    const db = await getDb();
    const custs = await customersOf(db, p.business_id);
    const obls = await obligationsOf(db, p.business_id);
    res.send(await ownerPage(req, p, "Customers", html`<h1>Customers</h1><p class="muted">Consent is a record, not a checkbox: when it was given, where, and the words. Revoked or do-not-call customers are never dialled.</p>
<div class="card"><div class="table-wrap"><table><tr><th>Name</th><th>Phone</th><th>Time zone</th><th>Consent</th><th>Owed</th><th></th></tr>
${custs.map((c) => { const owed = obls.filter((o) => o.customer_id === c.id && !["paid", "credited", "refunded", "void"].includes(o.status)).reduce((s, o) => s + balanceOf(o), 0); return html`<tr><td>${c.name}</td><td class="mono small">${c.phone}</td><td class="small">${c.tz}</td><td>${c.dnc ? pill("declined", "do not call") : c.consent ? (c.consent.revoked_at ? pill("declined", "revoked") : pill("paid", `granted ${c.consent.granted_at.slice(0, 10)}`)) : pill("warn", "none")}</td><td>${money(owed)}</td><td><a class="btn small" href="/customers/${c.id}">Open</a></td></tr>`; })}
</table></div></div>`));
  }));
  r.get("/customers/:id", authed(async (req, res, p) => {
    const db = await getDb();
    const c = await customerById(db, req.params.id, p.business_id);
    const obls = await obligationsOf(db, p.business_id, c.id);
    const calls = await callsOf(db, p.business_id, { customerId: c.id, limit: 20 });
    const events = await eventsOf(db, p.business_id, { customerId: c.id }, 30);
    res.send(await ownerPage(req, p, c.name, html`<p><a href="/customers">← Customers</a></p><h1>${c.name}</h1><p class="muted">${c.phone} · ${c.email || "no email"} · ${c.tz}${c.notes ? ` · ${c.notes}` : ""}</p>
<div class="grid2"><div class="card"><h3>Consent</h3>${c.dnc ? html`<p>${pill("declined", "do not call")} This customer asked not to be called.</p>` : c.consent ? html`<p>${c.consent.revoked_at ? pill("declined", "revoked") : pill("paid", "granted")} ${c.consent.granted_at.slice(0, 10)} via ${c.consent.source}</p><blockquote class="small">${c.consent.text}</blockquote>${c.consent.revoked_at ? html`<p class="small muted">Revoked ${c.consent.revoked_at.slice(0, 19)}</p>` : ""}` : html`<p>${pill("warn", "no consent on file")} Invoice by email only; the planner will never dial.</p>`}
${p.role === "owner" ? html`<form method="post" action="/customers/${c.id}/consent" class="stack"><label>Record consent <small class="muted">(the words the customer agreed to, and where)</small><input name="text" placeholder="You may call or text me about my account" required></label><input name="source" placeholder="e.g. booking form, signed on 3 Mar" required><div class="callbar"><button class="btn primary" name="op" value="grant" type="submit">Record consent</button><button class="btn" name="op" value="revoke" type="submit">Revoke / do not call</button></div></form>` : ""}
<p class="small muted">Customer link: <a href="/c/${c.token}">/c/${c.token.slice(0, 10)}…</a></p></div>
<div class="card"><h3>Money</h3><table><tr><th>Item</th><th>Amount</th><th>Discount</th><th>Settled</th><th>Status</th></tr>${obls.map((o) => html`<tr><td>${o.title}<br><small class="muted">${o.kind}${o.due_at ? ` · due ${fmtLocal(o.due_at, c.tz)}` : ""}${o.appointment_at ? ` · ${fmtLocal(o.appointment_at, c.tz)}` : ""}</small></td><td>${money(o.amount_cents)}</td><td>${o.discount_cents ? money(o.discount_cents) : "—"}</td><td>${money(o.settled_cents)}</td><td>${pill(o.status)}</td></tr>`)}</table></div></div>
<div class="card"><h3>Calls</h3><table><tr><th>Created</th><th>Purpose</th><th>Status</th><th>Outcome</th><th>Why</th><th></th></tr>${calls.map((x) => html`<tr><td class="small">${fmtDate(x.created_at)}</td><td>${purposeLabel[x.purpose]}</td><td>${pill(x.status)}</td><td>${x.outcome ?? ""}</td><td class="small">${x.reason}</td><td><a class="btn small" href="/calls/${x.id}">Open</a></td></tr>`)}</table>${calls.length ? "" : html`<div class="empty">No calls.</div>`}</div>
<div class="card"><h3>Events</h3><ul class="feed">${events.map((e: any) => html`<li><span class="small muted">${fmtDate(e.at)}</span> ${e.summary} <span class="small muted">· ${e.actor}</span></li>`)}</ul></div>`));
  }));
  r.post("/customers/:id/consent", act(async (req, res, p) => {
    ownerOnly(p);
    const db = await getDb();
    const c = await customerById(db, req.params.id, p.business_id);
    if (req.body.op === "revoke") {
      await db.query("UPDATE customers SET dnc = true, consent = jsonb_set(coalesce(consent, '{}'::jsonb), '{revoked_at}', to_jsonb(now()::text)) WHERE id = $1", [c.id]);
      await appendAudit("consent.revoked", "customer", c.id, { by: p.name });
      await logEvent(db, { businessId: p.business_id, customerId: c.id, type: "consent.revoked", summary: `${p.name} marked ${c.name} do-not-call`, actor: p.name });
      return back(res, `/customers/${c.id}`, "Marked do-not-call.");
    }
    const consent = { granted_at: new Date().toISOString(), source: String(req.body.source ?? "owner").slice(0, 120), text: String(req.body.text ?? "").slice(0, 500), revoked_at: null };
    await db.query("UPDATE customers SET dnc = false, consent = $2 WHERE id = $1", [c.id, JSON.stringify(consent)]);
    await appendAudit("consent.granted", "customer", c.id, { by: p.name, source: consent.source });
    await logEvent(db, { businessId: p.business_id, customerId: c.id, type: "consent.granted", summary: `Consent recorded for ${c.name} (${consent.source})`, actor: p.name });
    back(res, `/customers/${c.id}`, "Consent recorded.");
  }));

  /* ---------------- Call policy ---------------- */
  r.get("/policy", authed(async (req, res, p) => {
    ownerOnly(p);
    const db = await getDb();
    const pol = await activePolicy(p.business_id, db);
    const hist = await history(p.business_id, db);
    const limits = await guardSettings(p.business_id, db);
    const draftText = typeof req.query.draft === "string" ? req.query.draft : null;
    const compiled = draftText ? await compilePolicy(draftText) : null;
    const bt = backtest(hist, compiled?.rules ?? pol.rules, limits);
    const auto = await suggestAutonomy(p.business_id, db);
    const policies = await listPolicies(p.business_id);
    res.send(await ownerPage(req, p, "Call policy", html`<h1>Call policy</h1><p class="muted">Write who may be called, when, and how far the agent may go. Callback turns it into rules it can enforce, shows what it could not express, and replays the last 90 days of calls you made by hand through it.</p>
<div class="grid2"><div class="card"><form method="get" action="/policy"><label>Your words<textarea name="draft" rows="8" required>${draftText ?? pol.text}</textarea></label><div class="callbar"><button class="btn" type="submit">Compile and backtest</button></div></form>
${compiled ? html`<form method="post" action="/policy"><input type="hidden" name="text" value="${draftText}"><div class="callbar"><button class="btn primary" type="submit" name="op" value="activate">Adopt this policy</button><button class="btn" type="submit" name="op" value="draft">Save as draft</button></div></form>` : ""}
${compiled?.refused.length ? html`<div class="banner bad"><b>Refused:</b><ul>${compiled.refused.map((x) => html`<li>${x}</li>`)}</ul></div>` : ""}
${compiled?.unexpressed.length ? html`<div class="banner warn"><b>Understood but not a rule:</b><ul>${compiled.unexpressed.map((x) => html`<li>${x}</li>`)}</ul></div>` : ""}</div>
<div class="card"><h3>${compiled ? "Rules in the draft" : "Active rules"} <span class="small muted">compiled by ${compiled?.source ?? "rules"}</span></h3>${rulesTable(compiled?.rules ?? pol.rules)}</div></div>
<div class="card"><h2>Backtest: last 90 days, ${bt.cases} calls you made by hand</h2>
<div class="scorecard">${stat("Callback would run", bt.run, `${money(bt.collected_auto_cents)} collected on its own`)}${stat("Would wait for you", bt.wait, `${money(bt.held_cents)} held`)}${stat("Would not call", bt.deny, `${bt.breaches_prevented} outside hours or consent`)}${stat("Phone time saved", `${Math.round(bt.minutes_saved / 60 * 10) / 10} h`, `${Math.round(bt.minutes_still_by_hand)} min still yours`)}${stat("You would have declined", bt.would_have_declined, "runs you marked as bad")}</div>
<details><summary>Every case</summary><div class="table-wrap"><table class="small"><tr><th>When</th><th>Purpose</th><th>Customer</th><th>Amount</th><th>Outcome</th><th>Decision</th><th>Why</th></tr>${bt.rows.map((x) => html`<tr><td>${fmtDate(x.at)}</td><td>${purposeLabel[x.purpose]}</td><td>${x.customer}</td><td>${money(x.amount_cents)}</td><td>${x.outcome}</td><td>${pill(x.decision === "run" ? "allowed" : x.decision === "wait" ? "held" : "denied", x.decision)}</td><td>${x.why}</td></tr>`)}</table></div></details></div>
<div class="card"><h2>Earned autonomy</h2><p class="muted">From your approvals and declines (${auto.approvals} approved, ${auto.declines} declined):</p><ul>${auto.evidence.map((e) => html`<li>${e}</li>`)}</ul>${JSON.stringify(auto.suggested) !== JSON.stringify(auto.current) ? html`<form method="post" action="/ops/guard/autonomy/adopt"><button class="btn" type="submit">Adopt suggested limits</button></form>` : ""}</div>
<div class="card"><h3>History</h3><table class="small"><tr><th>When</th><th>Status</th><th>Source</th><th>Text</th></tr>${policies.map((x: any) => html`<tr><td>${fmtDate(x.created_at)}</td><td>${pill(x.status)}</td><td>${x.source}</td><td>${String(x.text).slice(0, 140)}</td></tr>`)}</table></div>`));
  }));
  r.post("/policy", act(async (req, res, p) => {
    ownerOnly(p);
    const text = String(req.body.text ?? "").slice(0, 4000);
    if (!text.trim()) throw new GtError("Write the policy first.", "empty");
    const compiled = await compilePolicy(text);
    if (compiled.refused.length && req.body.op === "activate") throw new GtError(`Cannot adopt: ${compiled.refused[0]}`, "refused");
    const id = await savePolicy(p.business_id, text, compiled, req.body.op === "activate", p.name);
    back(res, "/policy", req.body.op === "activate" ? `Policy ${id} is active. Calls are re-planned on the next tick.` : `Draft ${id} saved.`);
  }));

  return r;
}

export { raw };
