import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, Fingerprint, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { act } from "@/lib/api";
import { money } from "@/lib/format";
import { countersign, passkeysSupported } from "@/lib/passkey";
import { Panel } from "./bits";

import { t, tmap } from "@/i18n";
import { serverText } from "@/i18n/server-text";
export interface Approval {
  id: string; action: string; status: string; method: string | null; created_at: string; decided_at: string | null;
  cents: number | null; discount_pct: number | null; instalments: number | null; reason: string; safety_reasons: string[]; hash: string;
  customer: { id: string; name: string } | null; item: { id: string; title: string; kind: string; captured: boolean } | null; call_id: string | null; countersign: boolean;
}

const WHAT: Record<string, (a: Approval) => string> = {
  charge: (a) => t("Create a PayPal pay link for {amount} and send it to {name}.", { amount: money(a.cents), name: first(a) }),
  invoice: (a) => t("Send {name} a PayPal invoice for {amount}.", { amount: money(a.cents), name: first(a) }),
  plan: (a) => a.instalments && a.cents ? t("Offer {name} a PayPal instalment plan in {n} payments totalling {amount}.", { name: first(a), n: a.instalments, amount: money(a.cents) }) : t("Offer {name} a PayPal instalment plan.", { name: first(a) }),
  discount: (a) => t("Take {off} off what {name} owes.", { off: a.discount_pct ? `${a.discount_pct}%` : money(a.cents), name: first(a) }),
  hold: (a) => t("Text {name} a PayPal link to hold {amount} for their booking: charged only if they attend.", { amount: money(a.cents), name: first(a) }),
  refund: (a) => (a.item?.captured ? t("Refund {amount} through PayPal to the account {name} paid with.", { amount: money(a.cents), name: first(a) }) : t("Record a {amount} refund for {name}; it was paid outside PayPal, so you pay it back by hand.", { amount: money(a.cents), name: first(a) })),
};
const UNDO: Record<string, string> = tmap({
  charge: "Nothing is taken until they pay. After they pay, you can refund it from Money.",
  invoice: "Nothing is charged until they pay. You can cancel the invoice in PayPal.",
  plan: "Nothing is taken until they agree in PayPal. Either of you can cancel the plan there.",
  discount: "It only lowers the balance. Add a new charge to put the amount back.",
  hold: "Nothing is charged until you press Attended: charge on Money. Release frees it at once.",
  refund: "A sent refund can't be pulled back. That's why it waits for you.",
});
const first = (a: Approval) => a.customer?.name.split(" ")[0] ?? t("the customer");
export const ACTION: Record<string, string> = tmap({ charge: "Pay link", invoice: "Invoice", plan: "Instalment plan", discount: "Discount", refund: "Refund", hold: "Hold" });

export function ApprovalCard({ a, passkey, onDone, compact = false }: { a: Approval; passkey: boolean; onDone: () => void; compact?: boolean }) {
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const needsKey = a.countersign && passkey;
  const decide = async (op: "approve" | "decline") => {
    setBusy(op);
    try {
      if (op === "approve" && needsKey) {
        if (!passkeysSupported()) throw new Error(t("This browser can't use passkeys. Approve from a device with your passkey."));
        const r = await countersign(a.id);
        toast.success(`${t("Approved with your passkey.")} ${r.followUp?.message ?? ""}`.trim());
      } else {
        const r = await act(`/ops/guard/approvals/${a.id}`, { op });
        toast.success(r.message || (op === "approve" ? t("Approved.") : t("Declined. Nothing moved.")));
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
        <div className="min-w-[10rem] flex-1">
          <div className="text-sm font-medium">{ACTION[a.action] ?? a.action}{" "}{t("· waiting for you")}</div>
          <div className="font-display text-[1.6rem] font-[750] leading-tight num">{a.cents !== null ? money(a.cents) : a.discount_pct ? t("{0}% off", [a.discount_pct]) : "—"}</div>
        </div>
        <div className="w-full text-sm sm:w-auto sm:text-right">
          <div className="font-medium">{a.customer?.name ?? t("Unknown customer")}</div>
          <div className="text-ink-2">{a.item?.title}</div>
        </div>
      </div>
      <dl className="grid gap-3 px-4 py-4 text-[0.95rem] sm:grid-cols-[9rem_1fr]">
        <dt className="font-medium">{t("If you approve")}</dt>
        <dd>{(WHAT[a.action] ?? (() => t("Carry out this move.")))(a)}</dd>
        <dt className="font-medium">{t("Why it stopped")}</dt>
        <dd>{serverText(a.reason) || t("It is above the amount Callback may move on its own.")}{a.safety_reasons.length ? <span className="block text-sm text-hold">{t("Safety:")}{" "}{a.safety_reasons.join("; ")}</span> : null}</dd>
        {!compact ? (
          <>
            <dt className="font-medium">{t("Undo")}</dt>
            <dd className="text-ink-2">{UNDO[a.action] ?? t("Ask PayPal support.")}</dd>
            <dt className="font-medium">{t("If you decline")}</dt>
            <dd className="text-ink-2">{t("Nothing moves. The customer isn't told it was refused.")}</dd>
          </>
        ) : null}
      </dl>
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
        <Button onClick={() => decide("approve")} disabled={busy !== null} aria-busy={busy === "approve"}>
          {busy === "approve" ? <Loader2 className="animate-spin" /> : needsKey ? <Fingerprint /> : <Check />}
          {needsKey ? t("Approve {0} with passkey", [money(a.cents)]) : (a.cents !== null ? t("Approve {0}", [money(a.cents)]) : t("Approve"))}
        </Button>
        <Button variant="outline" onClick={() => decide("decline")} disabled={busy !== null} aria-busy={busy === "decline"}>
          {busy === "decline" ? <Loader2 className="animate-spin" /> : <X />}{" "}{t("Decline")}
        </Button>
        {a.call_id ? <Link to={`/calls/${a.call_id}`} className="ml-auto inline-flex min-h-11 items-center text-sm font-medium text-brand underline-offset-4 hover:underline">{t("Open the call")}</Link> : null}
      </div>
      {a.countersign && !passkey && !compact ? <p className="border-t border-line px-4 py-2 text-xs text-ink-2">{t("This is a big move: register a passkey on Needs you so big moves need your fingerprint or face, not just a click.")}</p> : null}
    </Panel>
  );
}
