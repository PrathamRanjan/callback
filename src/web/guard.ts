/** Guard console (roadmap B.6): approvals with passkey countersign, kill switches, autonomy limits, audit chain, provenance. */
import { Router } from "express";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { recentAudit, verifyChain } from "../guard/audit.js";
import { adoptSuggestions, suggestAutonomy } from "../guard/backtest.js";
import { decideApproval, guardSettings, pendingApprovals, saveGuardSettings } from "../guard/dryrun.js";
import { isKilled, listKills, setKill } from "../guard/kill.js";
import { finishRegistration, hasPasskey, newChallenge, PASSKEY_JS, verifyAssertion } from "../guard/passkey.js";
import { GtError } from "../lib/util.js";
import { act, authed, ownerOnly, requireOwner } from "./auth.js";
import { back, json } from "./common.js";
import { fmtDate, html, pill, raw } from "./html.js";
import { money, ownerPage } from "./views.js";

export async function killBanner() {
  const k = await isKilled("calls");
  return k?.engaged ? html`<div class="banner bad">Kill switch engaged on <b>${k.scope}</b>${k.reason ? `: ${k.reason}` : ""}. No calls are placed and no money moves.</div>` : html``;
}

export function guardRouter(): Router {
  const r = Router();
  r.get("/ops/guard", authed(async (req, res, p) => {
    ownerOnly(p);
    const db = await getDb();
    const approvals = await pendingApprovals(p.business_id);
    const kills = await listKills();
    const limits = await guardSettings(p.business_id, db);
    const chain = await verifyChain(db);
    const audit = await recentAudit(40);
    const pk = await hasPasskey(p.business_id, db);
    const auto = await suggestAutonomy(p.business_id, db);
    const prov = (await db.query<any>("SELECT trust, count(*) AS n FROM provenance GROUP BY trust ORDER BY trust")).rows;
    const scopes = ["global", "calls", "agents", "action:charge", "action:invoice", "action:plan", "action:discount", "action:refund", "purpose:confirm_deposit", "purpose:chase_invoice", "purpose:cancel_class"];
    res.send(await ownerPage(req, p, "Guard", html`<h1>Guard</h1>${await killBanner()}
<div class="grid2">
<div class="card"><h2>Held for you</h2><p class="muted small">Moves above your limits wait here. Approving is your click; from ${money(config.guard.countersignAboveCents)} a passkey countersign over the exact payload hash is required${pk ? "" : " once you register one"}.</p>
${approvals.filter((a) => a.status === "pending").length ? approvals.filter((a) => a.status === "pending").map((a) => html`<div class="option"><b>${a.action}</b> ${a.payload.cents ? money(Number(a.payload.cents)) : ""} · ${a.payload.reason ?? ""}<br><small class="mono muted">${a.payload_hash.slice(0, 16)} · ${fmtDate(a.created_at)}</small>
<div class="callbar"><form method="post" action="/ops/guard/approvals/${a.id}" class="inline"><button class="btn primary small" name="op" value="approve" type="submit">Approve</button> <button class="btn small" name="op" value="decline" type="submit">Decline</button></form>${pk && Number(a.payload.cents ?? 0) >= config.guard.countersignAboveCents ? html`<button class="btn small" data-countersign="${a.id}">Approve with passkey</button>` : ""}</div></div>`) : html`<div class="empty">Nothing held.</div>`}
<details><summary class="small">Recent decisions</summary><table class="small">${approvals.filter((a) => a.status !== "pending").slice(0, 20).map((a) => html`<tr><td>${fmtDate(a.decided_at)}</td><td>${a.action}</td><td>${a.payload.cents ? money(Number(a.payload.cents)) : ""}</td><td>${pill(a.status)}</td><td>${a.method ?? ""}</td></tr>`)}</table></details>
<h3>Passkey</h3>${pk ? html`<p>${pill("paid", "registered")} Countersign is live for large approvals.</p>` : html`<p><button class="btn" id="pk-register">Register a passkey</button> <span class="small muted">WebAuthn; attestation is not verified, the signature is.</span></p>`}</div>
<div class="card"><h2>Autonomy limits</h2><form method="post" action="/ops/guard/limits" class="stack"><label>Links and invoices without asking, up to $<input name="charge" type="number" min="0" step="1" value="${limits.auto_charge_max_cents / 100}"></label><label>Refunds without asking, up to $<input name="refund" type="number" min="0" step="1" value="${limits.auto_refund_max_cents / 100}"></label><label>Discount without asking, up to %<input name="discount" type="number" min="0" max="50" step="1" value="${limits.auto_discount_max_pct}"></label><button class="btn" type="submit">Save limits</button></form>
<h3>Earned autonomy</h3><ul class="small">${auto.evidence.map((e) => html`<li>${e}</li>`)}</ul>${JSON.stringify(auto.suggested) !== JSON.stringify(auto.current) ? html`<form method="post" action="/ops/guard/autonomy/adopt"><button class="btn" type="submit">Adopt suggested limits</button></form>` : ""}
<h2>Kill switches</h2><p class="muted small">Checked before every call and every money move.</p><table class="small">${scopes.map((s) => { const k = kills.find((x) => x.scope === s); return html`<tr><td><code>${s}</code></td><td>${k?.engaged ? pill("declined", "engaged") : pill("paid", "off")}</td><td><form method="post" action="/ops/guard/kill" class="inline"><input type="hidden" name="scope" value="${s}"><input type="hidden" name="engaged" value="${k?.engaged ? "0" : "1"}"><input name="reason" placeholder="reason" class="small"><button class="btn small" type="submit">${k?.engaged ? "Release" : "Engage"}</button></form></td></tr>`; })}</table></div></div>
<div class="card"><h2>Audit chain</h2><p>${chain.ok ? pill("paid", "intact") : pill("declined", `broken at ${chain.broken_at}`)} ${chain.rows} rows · head <code>${chain.head.slice(0, 16)}</code> · provenance: ${prov.map((x: any) => `${x.trust} ${x.n}`).join(", ") || "none yet"}</p><table class="small"><tr><th>Seq</th><th>When</th><th>Kind</th><th>Entity</th><th>Hash</th></tr>${audit.map((a: any) => html`<tr><td>${a.seq}</td><td>${fmtDate(a.at)}</td><td>${a.kind}</td><td>${a.entity} ${String(a.entity_id).slice(0, 14)}</td><td class="mono">${String(a.hash).slice(0, 12)}</td></tr>`)}</table></div>`, { scripts: raw(`<script>${PASSKEY_JS}</script><script src="/static/guard.js" defer></script>`) }));
  }));
  r.post("/ops/guard/approvals/:id", act(async (req, res, p) => {
    ownerOnly(p);
    const out = await decideApproval(req.params.id, req.body.op === "approve", "click", p.name, p.business_id);
    back(res, "/ops/guard", out.replayed ? `Already ${out.status}.` : `${out.status}. The agent retries the move on its next turn, or you can replay it from the call.`);
  }));
  r.post("/ops/guard/limits", act(async (req, res, p) => {
    ownerOnly(p);
    const n = (v: unknown) => Math.round(Number(v) || 0);
    await saveGuardSettings(p.business_id, { auto_charge_max_cents: n(req.body.charge) * 100, auto_refund_max_cents: n(req.body.refund) * 100, auto_discount_max_pct: n(req.body.discount) }, p.name);
    back(res, "/ops/guard", "Limits saved.");
  }));
  r.post("/ops/guard/autonomy/adopt", act(async (req, res, p) => {
    ownerOnly(p);
    const s = await adoptSuggestions(p.business_id, p.name);
    back(res, "/ops/guard", `Limits now ${money(s.auto_charge_max_cents)} / ${money(s.auto_refund_max_cents)} / ${s.auto_discount_max_pct}%.`);
  }));
  r.post("/ops/guard/kill", act(async (req, res, p) => {
    ownerOnly(p);
    const scope = String(req.body.scope ?? "global").slice(0, 60);
    await setKill(scope, req.body.engaged === "1", String(req.body.reason ?? "").slice(0, 200) || null, p.name);
    back(res, "/ops/guard", `${scope} ${req.body.engaged === "1" ? "engaged" : "released"}.`);
  }));
  // Passkey
  r.post("/ops/guard/passkey/register/start", json(async (req) => {
    const p = await requireOwner(req);
    const c = newChallenge(p.business_id, null);
    return { id: c.id, challenge: c.challenge, rpName: "Callback", userId: Buffer.from(p.business_id).toString("base64url"), userName: p.name };
  }));
  r.post("/ops/guard/passkey/register/finish", json(async (req) => {
    const p = await requireOwner(req);
    try {
      return await finishRegistration(p.business_id, String(req.body.chalId), req.body);
    } catch (e) {
      throw new GtError((e as Error).message, "bad_registration", 400);
    }
  }));
  r.post("/ops/guard/passkey/sign/start", json(async (req) => {
    const p = await requireOwner(req);
    const db = await getDb();
    const a = (await db.query<{ payload_hash: string }>("SELECT payload_hash FROM approvals WHERE id = $1", [String(req.body.approvalId)])).rows[0];
    if (!a) throw new GtError("No such approval", "not_found", 404);
    const c = newChallenge(p.business_id, a.payload_hash);
    return { id: c.id, challenge: c.challenge };
  }));
  r.post("/ops/guard/passkey/sign/finish", json(async (req) => {
    const p = await requireOwner(req);
    const db = await getDb();
    const a = (await db.query<{ payload_hash: string }>("SELECT payload_hash FROM approvals WHERE id = $1", [String(req.body.approvalId)])).rows[0];
    if (!a) throw new GtError("No such approval", "not_found", 404);
    const ok = await verifyAssertion(p.business_id, String(req.body.chalId), a.payload_hash, req.body);
    if (!ok) throw new GtError("Passkey assertion failed", "bad_assertion", 400);
    const out = await decideApproval(String(req.body.approvalId), true, "passkey", p.name, p.business_id);
    return { ...out, payload_hash: a.payload_hash };
  }));
  return r;
}
