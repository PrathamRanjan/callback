/** The public front door: what Callback is, how a call works, how it keeps customers safe, and a persona picker. */
import type { Request, Response } from "express";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { flashOf } from "./common.js";
import { html, layout, raw } from "./html.js";
import { icon } from "./icons.js";

const ic = (n: string) => raw(icon(n));

export async function landing(req: Request, res: Response) {
  const db = await getDb();
  const biz = (await db.query<any>("SELECT id, name FROM businesses ORDER BY created_at LIMIT 1").catch(() => ({ rows: [] as any[] }))).rows[0];
  const people = biz && config.demoMode ? (await db.query<any>("SELECT name, role FROM people WHERE business_id = $1 ORDER BY role DESC, name", [biz.id])).rows : [];
  const owner = people.find((p) => p.role === "owner");
  const staff = people.find((p) => p.role === "staff");
  const tom = biz ? (await db.query<any>("SELECT name, token FROM customers WHERE business_id = $1 AND name LIKE 'Tom%' LIMIT 1", [biz.id])).rows[0] : null;
  const first = (n?: string) => (n ?? "").split(" ")[0];
  res.send(layout({ title: "the calls you put off, made for you", site: true, flash: flashOf(req) }, html`
<section class="lp-hero"><div class="wrap lp-split">
  <div>
    <span class="lp-eyebrow"><b>Voice agent</b> for a small business's money calls</span>
    <h1 class="lp-title">The calls you put off, <em>made for you</em>.</h1>
    <p class="lp-lead">Callback rings customers about tomorrow's deposit, an overdue invoice or a cancelled class. It speaks inside your rules, texts a PayPal link while they're on the line, and hands anything bigger back to you.</p>
    <div class="lp-cta">${owner ? html`<form method="post" action="/demo/signin-as"><input type="hidden" name="role" value="owner"><button class="btn primary lg" type="submit">Try it as ${first(owner.name)}, the owner ${ic("arrowRight")}</button></form>` : html`<a class="btn primary lg" href="#try">Try the demo</a>`}<a class="btn lg" href="/judge">For judges</a></div>
    <div class="lp-trust" style="margin-top:1.5rem"><span>${ic("checkCircle")}PayPal sandbox, no real money</span><span>${ic("checkCircle")}Consent and calling hours checked in code</span><span>${ic("checkCircle")}Every call has a verify code</span></div>
  </div>
  <div class="mock" aria-hidden="true"><div class="mock-bar"><i></i><i></i><i></i><span>Live call · Priya Natarajan</span></div><div class="mock-body">
    <div class="mock-row"><span><span class="wave"><i></i><i></i><i></i><i></i><i></i></span> On the line, 0:42</span><span class="pill info">Deposit $60.00</span></div>
    <div class="bubble agent">Hi Priya, it's Callback for Brightside Physio. Your verify code is <b>4 1 7</b>. Tomorrow's assessment needs a $60 deposit. Shall I text you a PayPal link?</div>
    <div class="bubble cust">Yes please, send it now.</div>
    <div class="mock-row"><span>${ic("message")} PayPal link texted</span><span class="pill good">Paid · $60.00</span></div>
    <div class="guard-card hold" style="margin:0"><div class="gc-head">${ic("shieldAlert")}Refund to a different account refused</div><p class="gc-do" style="color:inherit">A caller asked for Tom's refund to go to a new PayPal. Refunds only go back to the account that paid.</p></div>
  </div></div>
</div></section>

<section class="lp-section alt" id="how"><div class="wrap">
  <p class="lp-kicker">How a call works</p><h2 class="lp-h2">It reads your records, rings at a decent hour, and never makes up a number.</h2>
  <p class="lp-sub">Every amount comes from your records and PayPal. The voice model chooses the words; code decides who may be called, what may be offered and what money may move.</p>
  <ol class="lp-steps">
    <li><h3>It plans who to call</h3><p>Deposits unpaid before tomorrow, invoices past their grace, classes you cancelled. Anyone without consent, on do-not-call, or outside local calling hours is skipped, with the reason shown.</p></li>
    <li><h3>It calls with a verify code</h3><p>The customer hears a three-digit code that matches the one on their own page, so they know it's really you.</p></li>
    <li><h3>It does only what your policy allows</h3><p>Text a PayPal link, send an invoice, offer an instalment or a discount step you approved, book a callback. Nothing else.</p></li>
    <li><h3>Anything bigger waits for you</h3><p>A larger discount, a refund over your limit, an odd request: held with a one-line reason, approved or declined by you with one tap.</p></li>
  </ol>
</div></section>

<section class="lp-section"><div class="wrap">
  <p class="lp-kicker">What's inside</p><h2 class="lp-h2">Built for a front desk of one.</h2>
  <div class="lp-features" style="margin-top:1.5rem">
    <div class="lp-feature"><span class="ic">${ic("calendar")}</span><h3>Today's call list</h3><p>Who will be called, why, and who won't be and why not. Nothing rings without passing the checks.</p></div>
    <div class="lp-feature"><span class="ic">${ic("wallet")}</span><h3>PayPal on the call</h3><p>Links, invoices, instalment plans and refunds through PayPal. A payment counts only when PayPal confirms it.</p></div>
    <div class="lp-feature"><span class="ic">${ic("file")}</span><h3>Your call policy</h3><p>Discount steps, instalment rules, refund limits and calling hours, versioned and tested against past calls before you switch.</p></div>
    <div class="lp-feature"><span class="ic">${ic("layers")}</span><h3>Every call is a trace</h3><p>Each line, each tool, each check and each PayPal request id, so you can see exactly why something happened.</p></div>
    <div class="lp-feature"><span class="ic">${ic("flask")}</span><h3>Tested on 60 customers</h3><p>Hagglers, people who are upset, people who are confused, and 25 scam and manipulation attempts run on demand.</p></div>
    <div class="lp-feature"><span class="ic">${ic("message")}</span><h3>Approve from your phone</h3><p>Held decisions reach you on Telegram or a push notification, with Approve and Decline buttons.</p></div>
  </div>
</div></section>

<section class="lp-section alt" id="safety"><div class="wrap lp-split">
  <div><p class="lp-kicker">Safe for your customers</p><h2 class="lp-h2">A call that asks for money has to earn trust.</h2>
  <p class="lp-sub">Scammers impersonate businesses by phone. Callback is built so your customers can tell the difference, and so a caller can't talk it into moving money somewhere new.</p>
  <ul class="stack" style="padding-left:1.1rem;color:var(--ui-muted-fg)"><li>A verify code on every call, matched on the customer's own page.</li><li>It never asks for a card number, a password or a one-time code.</li><li>Refunds only go back to the account that paid. A request to send money elsewhere is refused and flagged to you.</li><li>Someone claiming to be the owner can't change the rules mid-call.</li></ul></div>
  <div class="stack"><div class="guard-card hold"><div class="gc-head">${ic("shieldAlert")}Held for Maya</div><ul><li>Tom asked for 30% off; your policy allows 10% without you.</li></ul><p class="gc-do">Approve the bigger discount, or decline and Callback will offer the 10% step.</p><div class="row"><span class="btn small primary">Approve</span><span class="btn small">Decline</span></div></div>
  <div class="guard-card clear"><div class="gc-head">${ic("shieldCheck")}Within your rules</div><p class="gc-do">Harbour Dental: a two-part instalment plan for $840, which your policy allows.</p></div></div>
</div></section>

<section class="lp-section" id="access"><div class="wrap">
  <p class="lp-kicker">For everyone</p><h2 class="lp-h2">Make it comfortable before you start.</h2>
  <p class="lp-sub">These choices stay on this device and apply to every page, including the page your customers see. Change them any time from <b>Display</b> at the top of the screen.</p>
  <div class="a11y-quick"><button class="btn" type="button" data-q="textScale:1.5">${ic("type")}Bigger text</button><button class="btn" type="button" data-q="contrast:high">${ic("eye")}High contrast</button><button class="btn" type="button" data-q="font:hyperlegible">Easier-to-read font</button><button class="btn" type="button" data-q="readAloud:true">${ic("volume")}Read pages aloud</button><button class="btn" type="button" data-q="simpleWords:true">Plain words</button><button class="btn" type="button" data-q="bigTargets:true">Bigger buttons</button><button class="btn" type="button" data-q="extraTime:true">${ic("clock")}More time</button></div>
</div></section>

<section class="lp-section alt" id="try"><div class="wrap">
  <p class="lp-kicker">Try it</p><h2 class="lp-h2">Pick who you want to be.</h2>
  <p class="lp-sub">A demo physio and Pilates studio in Sydney, on the PayPal sandbox. Calls run in the browser simulator; when a PayPal page opens, sign in with the sandbox buyer account.</p>
  ${owner ? html`<div class="lp-personas">
    <div class="persona-card"><div class="who"><span class="avatar">${owner.name[0]}</span><span><b>${owner.name}</b><span>Owner, ${biz.name}</span></span></div><p>See today's call list and why some people won't be called. Start a call, watch it live, and approve or decline anything Callback holds for you.</p><form method="post" action="/demo/signin-as"><input type="hidden" name="role" value="owner"><button class="btn primary" type="submit">Continue as ${first(owner.name)} ${ic("arrowRight")}</button></form></div>
    ${staff ? html`<div class="persona-card"><div class="who"><span class="avatar">${staff.name[0]}</span><span><b>${staff.name}</b><span>Front desk, ${biz.name}</span></span></div><p>Work the call list and listen in. Staff can't change the policy, approve holds or move money.</p><form method="post" action="/demo/signin-as"><input type="hidden" name="role" value="staff"><button class="btn" type="submit">Continue as ${first(staff.name)} ${ic("arrowRight")}</button></form></div>` : ""}
    ${tom ? html`<div class="persona-card"><div class="who"><span class="avatar">${tom.name[0]}</span><span><b>${tom.name}</b><span>A customer</span></span></div><p>The page a customer opens from a text: what they owe or are owed, the verify code from the last call, and a PayPal button.</p><a class="btn" href="/c/${tom.token}">Open ${first(tom.name)}'s page ${ic("arrowRight")}</a></div>` : ""}
  </div>` : html`<div class="card"><p>The demo studio isn't loaded yet.</p><form method="post" action="/demo/reset"><input type="hidden" name="pin" value="1"><button class="btn primary" type="submit">Load the demo</button></form></div>`}
</div></section>`));
}
