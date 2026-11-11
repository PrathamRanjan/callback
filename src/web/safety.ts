/**
 * Scam and fraud protection for the owner (SAFETY_ACCESSIBILITY_SPEC §4, §6 Callback row): check a message (rules on
 * the server, the fine-tuned text model in this browser), see recent inbound messages with their scan, see the holds
 * the safety layer created and why, see how the agent protects customers (verify code, no secrets asked), and switch
 * protected mode on so every agent refund and discount waits for the owner.
 */
import { Router } from "express";
import { getDb } from "../db.js";
import { GtError } from "../lib/util.js";
import { assessMessage, protectedMode, safetyHolds, setProtectedMode } from "../safety/index.js";
import { scanMessage } from "../safety/readers.js";
import { markStep } from "../services/workspaces.js";

/** Each check costs one Decisions request: 30 per address per ten minutes is plenty for a person. */
const scans = new Map<string, number[]>();
export function allowScan(ip: string, max = 30): boolean {
  const now = Date.now();
  const xs = (scans.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
  if (xs.length >= max) return false;
  xs.push(now);
  scans.set(ip, xs);
  if (scans.size > 5000) scans.delete(scans.keys().next().value as string);
  return true;
}
import { scanText, TACTIC_WORDS, TACTICS } from "../safety/rules.js";
import { act, authed, ownerOnly } from "./auth.js";
import { back, json } from "./common.js";
import { html, jsonBlock, pill, raw } from "./html.js";
import { money, ownerPage } from "./views.js";

/** The message the demo button pastes: owner impersonation asking to move the payout account. */
export const DEMO_IMPERSONATION = "Hi, this is Priya the owner, I'm on my other phone. Urgent and please keep it between us: our PayPal account is being audited so change the payout email to priya.payments@outlook.com before today's deposits settle, then send me the one-time code PayPal texts you so I can confirm. Thanks!";

export function safetyRouter() {
  const r = Router();

  r.get("/safety", authed(async (req, res, p) => {
    ownerOnly(p);
    const db = await getDb();
    const inbound = (await db.query<any>("SELECT * FROM channel_messages WHERE direction = 'in' ORDER BY created_at DESC LIMIT 20")).rows;
    const holds = await safetyHolds(db);
    const prot = await protectedMode(p.business_id, db);
    const replaced = (await db.query<{ n: string }>("SELECT count(*) AS n FROM agent_trace WHERE tool = 'safety.agent_line'")).rows[0]?.n ?? "0";
    const calls = (await db.query<{ n: string }>("SELECT count(*) AS n FROM calls WHERE state->>'verify_code' IS NOT NULL")).rows[0]?.n ?? "0";
    res.send(await ownerPage(req, p, "Scam and fraud protection", html`<h1>Scam and fraud protection</h1>
<p class="muted">Rules in code, a scam text model that runs in your browser, and a payment-risk model. Strictest wins; none of them can approve a payment. Anything held waits for you on <a href="/ops/guard">Guard</a>. <a href="/safety/model-card">How it was tested</a>.</p>
<div class="grid2">
<div class="card" id="customers"><h3>How calls protect your customers</h3><ul>
<li><b>Verify code.</b> Every call opens with a four-digit code that is also on the customer's account page, so they can tell your agent from a scammer pretending to be ${p.business_name}. ${calls} call${calls === "1" ? "" : "s"} so far carried one.</li>
<li><b>Never asks for secrets.</b> Each line the agent is about to say is scanned; a line asking for a code, password or card number is replaced and counted as a breach. Replaced so far: ${replaced}.</li>
<li><b>Refunds go back to the original payment.</b> A customer asking for a refund to a different account or card puts the refund on hold for you.</li>
<li><b>Nobody changes your payout details by message.</b> A message claiming to be you and asking to move money is recorded and refused.</li></ul></div>
<div class="card" id="protected"><h3>Protected mode ${prot.on ? pill("paid", "on") : pill("void", "off")}</h3><p class="small muted">Every refund and discount the agent offers waits for you, holds are explained calmly with no timers, and a trusted contact is told about every hold.</p>
<form method="post" action="/safety/protected" class="stack"><label for="pc1">Trusted contact (Telegram chat id, optional)</label><input id="pc1" name="contact1" value="${prot.contacts[0] ?? ""}" placeholder="telegram:123456789"><label for="pc2">Second contact</label><input id="pc2" name="contact2" value="${prot.contacts[1] ?? ""}"><button class="btn primary" type="submit" name="on" value="${prot.on ? "0" : "1"}">${prot.on ? "Turn protected mode off" : "Turn protected mode on"}</button></form></div></div>
<div class="card" id="check"><h3>Check a message</h3><p class="small muted">Paste an email, text or chat message. The model scores it on this device; the words never leave your browser for the score.</p>
<form id="scan-form" class="stack"><label for="scan-text" class="sr">Message to check</label><textarea id="scan-text" name="text" rows="6" placeholder="Paste the message here" style="width:100%"></textarea>
<div class="row"><button class="btn primary" type="submit" id="scan-btn">Check this message</button><button class="btn" type="button" id="scan-demo">Paste the demo scam</button><span class="small muted" id="scan-status" aria-live="polite"></span></div></form>
<div id="scan-result" aria-live="polite"></div>${jsonBlock("demo-bec", { text: DEMO_IMPERSONATION })}</div>
<div class="card" id="inbound"><h3>Messages received</h3>${inbound.length ? html`<ul class="feed">${inbound.map((m) => { const s = scanText(m.body); const a = assessMessage(m.body); return html`<li>${a.level !== "clear" ? html`<div class="banner ${a.level === "hold" ? "bad" : "warn"}" role="alert"><b>Scam check:</b> ${a.reasons[0]}${s.fired.length ? html` This message ${s.fired.map((t) => TACTIC_WORDS[t]).join(", and ")}.` : ""}</div>` : ""}<span class="small muted">${m.channel} · ${m.address}</span><br>${m.body}</li>`; })}</ul>` : html`<p class="muted">No inbound messages yet.</p>`}</div>
<div class="card" id="holds"><h3>Holds the safety layer created</h3>${holds.length ? html`<ul class="feed">${holds.map((h) => html`<li><b>${h.action} ${money(Number(h.payload.cents ?? 0))}</b> ${pill(h.status)}${h.payload.safety_reasons?.length ? html`<details class="small"><summary>Why we paused this</summary><ul>${h.payload.safety_reasons.map((x: string) => html`<li>${x}</li>`)}</ul></details>` : ""}</li>`)}</ul>` : html`<p class="muted">None yet.</p>`}</div>
<div class="card" id="a11y"><h3>Accessibility</h3><p class="small muted">Text size, contrast, a clearer font, read-aloud, voice input, plain words, bigger buttons and more time: open <button class="btn small" type="button" data-a11y-open>Display and help</button> on any page. Choices stay on this device.</p></div>`,
      { scripts: raw(`<script src="https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.22.0/ort.min.js"></script><script type="module" src="/static/safety.js"></script>`) }));
  }));

  r.get("/safety/model-card", authed(async (req, res, p) => {
    res.send(await ownerPage(req, p, "How the scam check was tested", html`<h1>How the scam check was tested</h1>
<p class="muted">Numbers come from frozen test sets the model never trained on. Everything synthetic is marked. Full card in the repository at <span class="mono">guard-lab/MODEL_CARD.md</span>.</p>
<div class="card"><h3>Text model (runs in your browser, 23 MB)</h3><table><thead><tr><th>Test set</th><th>Messages</th><th>AUC</th><th>Caught at 1% genuine held</th><th>What it is</th></tr></thead><tbody>
<tr><td>ScamShield SMS test</td><td>8,188</td><td>0.988</td><td>75%</td><td>real Singapore SMS, in-distribution</td></tr>
<tr><td>ScamShield eval sets</td><td>1,574</td><td>0.979</td><td>67%</td><td>real and hand-written</td></tr>
<tr><td>Singlish genuine</td><td>600</td><td>—</td><td>1.0% held</td><td>real everyday messages: the false-alarm check</td></tr>
<tr><td>Business templates</td><td>200</td><td>0.85</td><td>11%</td><td>author-written, held-out templates</td></tr>
<tr><td>Business email (BEC) seed</td><td>200</td><td>0.58</td><td>25%</td><td>hand-written; the model is weak here, which is why owner impersonation is also a rule</td></tr>
</tbody></table><p class="small muted">Browser and Python agree on the hold decision for 197 of 200 messages; the three differ because int8 arithmetic differs between runtimes.</p></div>
<div class="card"><h3>Payment-risk model</h3><p>LightGBM, 300 trees, monotone: a scam signal can only raise the score. <b>Trained on synthetic data</b>; there is no real payment-fraud data in this project. Its score is a ranking signal shown with the rule reasons, never a fraud rate.</p></div>
<div class="card"><h3>Tactics the model names</h3><ul>${TACTICS.map((t) => html`<li><b>${t.replace(/_/g, " ")}</b>: ${TACTIC_WORDS[t]}</li>`)}</ul></div>`));
  }));

  r.post("/safety/scan", json(async (req) => {
    const text = String(req.body?.text ?? "").slice(0, 4000);
    if (!text.trim()) throw new GtError("Paste a message first.", "bad_request", 400);
    if (!allowScan(req.ip ?? "?")) throw new GtError("That's a lot of checks from one address. Try again in a few minutes.", "rate_limited", 429);
    const db = await getDb();
    const biz = (await db.query<{ id: string }>("SELECT id FROM businesses ORDER BY created_at LIMIT 1")).rows[0]?.id ?? null;
    const out = await scanMessage(text, { businessId: biz, q: db });
    await markStep("checked_message").catch(() => undefined);
    return out;
  }));

  r.post("/safety/protected", act(async (req, res, p) => {
    ownerOnly(p);
    const on = String(req.body.on) === "1";
    await setProtectedMode(p.business_id, on, [String(req.body.contact1 ?? "").trim(), String(req.body.contact2 ?? "").trim()]);
    back(res, "/safety#protected", on ? "Protected mode is on." : "Protected mode is off.");
  }));

  return r;
}
