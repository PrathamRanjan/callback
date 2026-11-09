import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, Fingerprint, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { act } from "@/lib/api";
import { money } from "@/lib/format";
import { countersign, passkeysSupported } from "@/lib/passkey";
import { Panel } from "./bits";

export interface Approval {
  id: string; action: string; status: string; method: string | null; created_at: string; decided_at: string | null;
  cents: number | null; discount_pct: number | null; instalments: number | null; reason: string; safety_reasons: string[]; hash: string;
  customer: { id: string; name: string } | null; item: { id: string; title: string; kind: string; captured: boolean } | null; call_id: string | null; countersign: boolean;
}

const WHAT: Record<string, (a: Approval) => string> = {
  charge: (a) => `Create a PayPal pay link for ${money(a.cents)} and send it to ${first(a)}.`,
  invoice: (a) => `Send ${first(a)} a PayPal invoice for ${money(a.cents)}.`,
  plan: (a) => `Offer ${first(a)} a PayPal instalment plan${a.instalments ? ` in ${a.instalments} payments` : ""}${a.cents ? ` totalling ${money(a.cents)}` : ""}.`,
  discount: (a) => `Take ${a.discount_pct ? `${a.discount_pct}%` : money(a.cents)} off what ${first(a)} owes.`,
  refund: (a) => (a.item?.captured ? `Refund ${money(a.cents)} through PayPal to the account ${first(a)} paid with.` : `Record a ${money(a.cents)} refund for ${first(a)}; it was paid outside PayPal, so you pay it back by hand.`),
};
const UNDO: Record<string, string> = {
  charge: "Nothing is taken until they pay. After they pay, you can refund it from Money.",
  invoice: "Nothing is charged until they pay. You can cancel the invoice in PayPal.",
  plan: "Nothing is taken until they agree in PayPal. Either of you can cancel the plan there.",
  discount: "It only lowers the balance. Add a new charge to put the amount back.",
  refund: "A sent refund can't be pulled back. That's why it waits for you.",
};
const first = (a: Approval) => a.customer?.name.split(" ")[0] ?? "the customer";
const ACTION: Record<string, string> = { charge: "Pay link", invoice: "Invoice", plan: "Instalment plan", discount: "Discount", refund: "Refund" };

export function ApprovalCard({ a, passkey, onDone, compact = false }: { a: Approval; passkey: boolean; onDone: () => void; compact?: boolean }) {
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const needsKey = a.countersign && passkey;
  const decide = async (op: "approve" | "decline") => {
    setBusy(op);
    try {
      if (op === "approve" && needsKey) {
        if (!passkeysSupported()) throw new Error("This browser can't use passkeys. Approve from a device with your passkey.");
        const r = await countersign(a.id);
        toast.success(`Approved with your passkey. ${r.followUp?.message ?? ""}`.trim());
      } else {
        const r = await act(`/ops/guard/approvals/${a.id}`, { op });
        toast.success(r.message || (op === "approve" ? "Approved." : "Declined. Nothing moved."));
      }
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Panel className="overflow-hidden border-hold/50">
      <div className="flex flex-wrap items-start gap-3 border-b border-line bg-hold-soft px-4 py-3">
        <span className="lamp mt-1.5" data-s="hold" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{ACTION[a.action] ?? a.action} · waiting for you</div>
          <div className="font-display text-[1.6rem] font-[750] leading-tight num">{a.cents !== null ? money(a.cents) : a.discount_pct ? `${a.discount_pct}% off` : "—"}</div>
        </div>
        <div className="text-right text-sm">
          <div className="font-medium">{a.customer?.name ?? "Unknown customer"}</div>
          <div className="text-ink-2">{a.item?.title}</div>
        </div>
      </div>
      <dl className="grid gap-3 px-4 py-4 text-[0.95rem] sm:grid-cols-[9rem_1fr]">
        <dt className="font-medium">If you approve</dt>
        <dd>{(WHAT[a.action] ?? (() => "Carry out this move."))(a)}</dd>
        <dt className="font-medium">Why it stopped</dt>
        <dd>{a.reason || "It is above the amount Callback may move on its own."}{a.safety_reasons.length ? <span className="block text-sm text-hold">Safety: {a.safety_reasons.join("; ")}</span> : null}</dd>
        {!compact ? (
          <>
            <dt className="font-medium">Undo</dt>
            <dd className="text-ink-2">{UNDO[a.action] ?? "Ask PayPal support."}</dd>
            <dt className="font-medium">If you decline</dt>
            <dd className="text-ink-2">Nothing moves. The customer isn't told it was refused.</dd>
          </>
        ) : null}
      </dl>
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
        <Button onClick={() => decide("approve")} disabled={busy !== null} aria-busy={busy === "approve"}>
          {busy === "approve" ? <Loader2 className="animate-spin" /> : needsKey ? <Fingerprint /> : <Check />}
          {needsKey ? `Approve ${money(a.cents)} with passkey` : `Approve ${a.cents !== null ? money(a.cents) : ""}`.trim()}
        </Button>
        <Button variant="outline" onClick={() => decide("decline")} disabled={busy !== null} aria-busy={busy === "decline"}>
          {busy === "decline" ? <Loader2 className="animate-spin" /> : <X />} Decline
        </Button>
        {a.call_id ? <Link to={`/calls/${a.call_id}`} className="ml-auto text-sm font-medium text-brand underline-offset-4 hover:underline">Open the call</Link> : null}
      </div>
      {a.countersign && !passkey && !compact ? <p className="border-t border-line px-4 py-2 text-xs text-ink-2">This is a big move: register a passkey on Needs you so big moves need your fingerprint or face, not just a click.</p> : null}
    </Panel>
  );
}
