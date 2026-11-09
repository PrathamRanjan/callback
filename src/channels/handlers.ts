/**
 * Inbound channel handling: the owner's Approve / Decline buttons from Telegram or WhatsApp, a customer's STOP by SMS
 * (revokes consent in code, immediately), and simple status questions from a linked customer.
 */
import { getDb } from "../db.js";
import { appendAudit } from "../guard/audit.js";
import { decideApproval } from "../guard/dryrun.js";
import { customerByToken, logEvent } from "../store.js";
import { onInbound } from "./index.js";

export function installChannelHandlers() {
  onInbound(async (m0) => {
    let m = m0;
    const db = await getDb();
    const text = m.text.trim();
    if (!m.party && m.channel === "simulator" && /^(owner|customer):/.test(m.address)) m = { ...m, party: { party: m.address.split(":")[0], party_id: m.address.slice(m.address.indexOf(":") + 1) } };
    // Customer STOP by SMS: find the customer by phone, revoke consent.
    if (m.channel === "sms" && /^(stop|unsubscribe|do not call|don't call)/i.test(text)) {
      const c = (await db.query<{ id: string; business_id: string; name: string }>("SELECT id, business_id, name FROM customers WHERE regexp_replace(phone, '[^0-9+]', '', 'g') = regexp_replace($1, '[^0-9+]', '', 'g')", [m.address])).rows[0];
      if (c) {
        await db.query("UPDATE customers SET dnc = true, consent = jsonb_set(coalesce(consent, '{}'::jsonb), '{revoked_at}', to_jsonb(now()::text)) WHERE id = $1", [c.id]);
        await appendAudit("consent.revoked", "customer", c.id, { by: "customer STOP by sms" });
        await logEvent(db, { businessId: c.business_id, customerId: c.id, type: "consent.revoked", summary: `${c.name} texted STOP: marked do-not-call`, actor: "customer" });
      }
      return "You've been removed from calls and texts. Anything owed stays on your account; the office can email you.";
    }
    // Owner approval buttons.
    if (m.party?.party === "owner" || m.channel === "simulator") {
      const btn = m.buttonId ?? /^(approve|decline)[: ](\S+)/i.exec(text)?.slice(1).join(":") ?? null;
      const mm = btn ? /^(approve|decline):(.+)$/.exec(btn) : null;
      if (mm) {
        try {
          const r = await decideApproval(mm[2], mm[1] === "approve", "channel", `${m.channel}:${m.address}`, m.party?.party_id);
          return r.replayed ? `Already ${r.status}.` : `${mm[1] === "approve" ? "Approved" : "Declined"}: ${r.payload.action} of $${((r.payload.cents ?? 0) / 100).toFixed(2)}.`;
        } catch (e) {
          return `Could not decide: ${(e as Error).message}`;
        }
      }
      if (m.party?.party === "owner" && /pending|holds?|approvals?/i.test(text)) {
        const n = (await db.query<{ n: string }>("SELECT count(*) AS n FROM approvals WHERE status = 'pending'")).rows[0].n;
        return `${n} pending approval${n === "1" ? "" : "s"}. Open the Guard page or reply "approve <id>".`;
      }
    }
    // Customer status by token-linked address.
    if (m.party?.party === "customer") {
      try {
        const c = await customerByToken(db, m.party.party_id);
        const open = (await db.query<{ title: string; amount_cents: number; discount_cents: number; settled_cents: number }>("SELECT title, amount_cents, discount_cents, settled_cents FROM obligations WHERE customer_id = $1 AND status NOT IN ('paid','credited','refunded','void')", [c.id])).rows;
        if (!open.length) return `Hi ${c.name.split(" ")[0]}, nothing is outstanding on your account.`;
        return `Hi ${c.name.split(" ")[0]}: ` + open.map((o) => `${o.title} $${((Number(o.amount_cents) - Number(o.discount_cents) - Number(o.settled_cents)) / 100).toFixed(2)}`).join("; ") + ". Reply STOP to opt out of calls.";
      } catch {
        return null;
      }
    }
    return null;
  });
}
