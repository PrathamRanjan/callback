import { useState } from "react";
import { Fingerprint, OctagonX, Power, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ActButton, Empty, ErrorState, PageHead, Panel, Rows, Section, StateChip } from "@/components/app/bits";
import { ApprovalCard, type Approval } from "@/components/app/approval";
import { act } from "@/lib/api";
import { money, moneyLamp, plural, when, word } from "@/lib/format";
import { passkeysSupported, registerPasskey } from "@/lib/passkey";
import { useData, useSession, useTitle } from "@/lib/hooks";

import { t, tk, tmap } from "@/i18n";
interface Limits { auto_charge_max_cents: number; auto_refund_max_cents: number; auto_discount_max_pct: number }
interface Guard {
  pending: Approval[]; decided: Approval[]; limits: Limits;
  autonomy: { current: Limits; suggested: Limits; evidence: string[]; approvals: number; declines: number };
  passkey: boolean; countersign_cents: number;
  kills: { scope: string; engaged: boolean; reason: string | null }[];
  chain: { ok: boolean; rows: number; head: string; broken_at: number | null };
  audit: { seq: number; at: string; kind: string; entity: string; entity_id: string; hash: string }[];
}
const SCOPE: Record<string, string> = tmap({
  global: "Everything", calls: "All calls", agents: "The AI agent", "action:charge": "Pay links", "action:invoice": "Invoices", "action:plan": "Instalment plans", "action:discount": "Discounts", "action:refund": "Refunds",
  "purpose:confirm_deposit": "Deposit calls", "purpose:chase_invoice": "Invoice calls", "purpose:cancel_class": "Cancelled-class calls",
});

function LimitsForm({ g, onDone }: { g: Guard; onDone: () => void }) {
  const [v, setV] = useState({ charge: String(g.limits.auto_charge_max_cents / 100), refund: String(g.limits.auto_refund_max_cents / 100), discount: String(g.limits.auto_discount_max_pct) });
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="grid gap-3 sm:grid-cols-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          toast.success((await act("/ops/guard/limits", v)).message || t("Limits saved."));
          onDone();
        } catch (x) {
          toast.error((x as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {([["charge", tk("Pay links and invoices up to ($)")], ["refund", tk("Refunds up to ($)")], ["discount", tk("Discounts up to (%)")]] as const).map(([k, l]) => (
        <div key={k} className="grid gap-1.5">
          <Label htmlFor={`lim-${k}`}>{t(l)}</Label>
          <Input id={`lim-${k}`} inputMode="numeric" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value.replace(/[^0-9]/g, "") })} className="h-11 num" />
        </div>
      ))}
      <div className="sm:col-span-3"><Button type="submit" variant="outline" disabled={busy}>{t("Save limits")}</Button></div>
    </form>
  );
}

export default function ApprovalsPage() {
  useTitle(t("Needs you"));
  const { reload: reloadSession } = useSession();
  const { data: g, error, loading, reload } = useData<Guard>("/api/app/guard", { poll: 10000 });
  const refresh = async () => {
    await reload();
    await reloadSession();
  };
  if (error && !g) return <ErrorState error={error} retry={reload} />;
  if (loading && !g) return <Rows n={4} />;
  if (!g) return null;
  const engaged = g.kills.filter((k) => k.engaged);
  const a = g.autonomy;
  const changes = a.suggested.auto_charge_max_cents !== a.current.auto_charge_max_cents || a.suggested.auto_refund_max_cents !== a.current.auto_refund_max_cents || a.suggested.auto_discount_max_pct !== a.current.auto_discount_max_pct;
  return (
    <>
      <PageHead
        title={t("Needs you")}
        happened={t("{0} so far. Audit chain {1}.", [plural(g.decided.length, "decision"), g.chain.ok ? `verified across ${g.chain.rows} entries` : `broken at entry ${g.chain.broken_at}`])}
        needs={g.pending.length ? t("{0} waiting.", [plural(g.pending.length, "money move")]) : t("Nothing waiting.")}
        next={engaged.length ? t("Stopped: {0}.", [engaged.map((k) => SCOPE[k.scope] ?? k.scope).join(", ")]) : t("Callback moves up to {0} and refunds up to {1} on its own.", [money(g.limits.auto_charge_max_cents), money(g.limits.auto_refund_max_cents)])}
      />
      <Section id="pending" title={t("Waiting for you")}>
        <div className="space-y-4" data-tour="approvals">
          {g.pending.length ? g.pending.map((x) => <ApprovalCard key={x.id} a={x} passkey={g.passkey} onDone={refresh} />) : <Empty title={t("Nothing is waiting")}>{t("Anything over your limits will stop here, with what moves, to whom, why and how to undo it.")}</Empty>}
        </div>
      </Section>

      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Section id="limits" title={t("What Callback may do alone")}>
          <Panel className="p-4">
            <LimitsForm g={g} onDone={refresh} />
            {a.evidence.length ? (
              <div className="mt-4 rounded-[10px] bg-paper p-3 text-sm">
                <div className="mb-1 flex items-center gap-1.5 font-medium"><Sparkles className="size-4" />{t("Learned from your decisions")}</div>
                <ul className="list-disc space-y-1 pl-5 text-ink-2">{a.evidence.map((e) => <li key={e}>{e}</li>)}</ul>
                {changes ? <ActButton path="/ops/guard/autonomy/adopt" size="sm" variant="outline" className="mt-2" onDone={refresh}>{t("Use the suggested limits")}</ActButton> : null}
              </div>
            ) : null}
          </Panel>
        </Section>
        <Section id="passkey" title={t("Passkey for big moves")}>
          <Panel className="p-4">
            <p className="text-sm">{g.passkey ? t("On. Moves of {0} or more need your fingerprint, face or device PIN.", [money(g.countersign_cents)]) : t("Off. Register a passkey so moves of {0} or more need more than a click.", [money(g.countersign_cents)])}</p>
            {!g.passkey ? (
              <Button
                variant="outline"
                className="mt-3"
                disabled={!passkeysSupported()}
                onClick={async () => {
                  try {
                    await registerPasskey();
                    toast.success(t("Passkey registered."));
                    await reload();
                  } catch (e) {
                    toast.error((e as Error).message);
                  }
                }}
              >
                <Fingerprint />{" "}{t("Register a passkey")}
              </Button>
            ) : <StateChip s="done">{t("Passkey registered")}</StateChip>}
          </Panel>
        </Section>
      </div>

      <Section id="kill" title={t("Stop switches")} hint={t("Stops that kind of move at once, before any PayPal call. Nothing already sent is undone.")}>
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {g.kills.map((k) => (
            <li key={k.scope}>
              <Panel className={`flex items-center gap-3 p-3 ${k.engaged ? "border-off/60 bg-off-soft" : ""}`}>
                <span className="lamp" data-s={k.engaged ? "off" : "done"} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{SCOPE[k.scope] ?? k.scope}</div>
                  <div className="truncate text-xs text-ink-2">{k.engaged ? t("Stopped{0}", [k.reason ? `: ${k.reason}` : ""]) : t("Running")}</div>
                </div>
                <ActButton
                  path="/ops/guard/kill"
                  fields={{ scope: k.scope, engaged: k.engaged ? "0" : "1", reason: k.engaged ? "" : "stopped by the owner" }}
                  size="sm"
                  variant={k.engaged ? "outline" : "ghost"}
                  icon={k.engaged ? <Power /> : <OctagonX />}
                  confirmText={k.engaged ? undefined : t("Stop {0}?", [SCOPE[k.scope] ?? k.scope])}
                  onDone={refresh}
                >
                  {k.engaged ? t("Start") : t("Stop")}
                </ActButton>
              </Panel>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="decided" title={t("Decided")}>
        {g.decided.length ? (
          <Panel className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead>{t("When")}</TableHead><TableHead>{t("Move")}</TableHead><TableHead>{t("Customer")}</TableHead><TableHead className="text-right">{t("Amount")}</TableHead><TableHead>{t("Decision")}</TableHead></TableRow></TableHeader>
              <TableBody>
                {g.decided.map((x) => (
                  <TableRow key={x.id}>
                    <TableCell className="whitespace-nowrap text-ink-2 num">{when(x.decided_at ?? x.created_at)}</TableCell>
                    <TableCell>{x.action}</TableCell>
                    <TableCell>{x.customer?.name}</TableCell>
                    <TableCell className="text-right num">{money(x.cents)}</TableCell>
                    <TableCell><StateChip s={moneyLamp(x.status)}>{word(x.status)}{x.method ? ` · ${x.method}` : ""}</StateChip></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
        ) : <Empty title={t("No decisions yet")} />}
      </Section>

      <Section id="audit" title={t("Audit chain")} hint={t("Every money decision is hash-chained; editing any entry breaks the chain from that point.")}>
        <Panel className="p-4">
          <StateChip s={g.chain.ok ? "done" : "off"}>{g.chain.ok ? t("Verified · {0} entries", [g.chain.rows]) : t("Broken at {0}", [g.chain.broken_at])}</StateChip>
          <p className="mt-2 break-all font-mono text-xs text-ink-2">{t("Head")}{" "}{g.chain.head}</p>
          <ul className="mt-3 max-h-[320px] space-y-1 overflow-y-auto text-sm">
            {g.audit.map((x) => <li key={x.seq} className="flex gap-3"><span className="w-10 font-mono text-xs text-ink-2 num">#{x.seq}</span><span className="flex-1">{x.kind.replace(/[._]/g, " ")} · {x.entity}</span><span className="font-mono text-xs text-ink-2">{x.hash}</span></li>)}
          </ul>
        </Panel>
      </Section>
    </>
  );
}
