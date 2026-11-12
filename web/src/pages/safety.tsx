import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ActButton, Empty, ErrorState, PageHead, Panel, Rows, Section, StateChip } from "@/components/app/bits";
import { ScamCheck, type ServerScan } from "@/components/app/scam-check";
import { money, when, word, plural } from "@/lib/format";
import { useData, useTitle } from "@/lib/hooks";
import type { LampState } from "@/lib/format";

import { t } from "@/i18n";
type Scan = ServerScan;
interface SafetyData {
  protected: { on: boolean; contacts: string[] };
  holds: { id: string; action: string; status: string; cents: number; reasons: string[]; rule: string | null; created_at: string }[];
  inbound: { channel: string; address: string; body: string; created_at: string; scan: Scan }[];
  replaced: number; verified_calls: number; demo_message: string | null;
}
const LEVEL: Record<string, [LampState, string]> = { hold: ["off", "Hold: don't pay or reply yet"], caution: ["hold", "Caution: check before you act"], clear: ["idle", "Not fully checked"] };

export default function SafetyPage() {
  useTitle(t("Scam guard"));
  const { data: d, error, loading, reload } = useData<SafetyData>("/api/app/safety");
  const [c1, setC1] = useState<string | null>(null);
  const [c2, setC2] = useState<string | null>(null);
  if (error && !d) return <ErrorState error={error} retry={reload} />;
  if (loading && !d) return <Rows n={4} />;
  if (!d) return null;
  return (
    <>
      <PageHead
        title={t("Scam guard")}
        happened={t("{calls} carried a verify code; unsafe agent lines replaced: {n}.", { calls: plural(d.verified_calls, "call"), n: d.replaced })}
        needs={d.holds.some((h) => h.status === "pending") ? t("A move the scam guard paused is waiting on Needs you.") : undefined}
        next={t("Rules in code, a text model in your browser and a payment-risk model. The strictest wins; none of them can approve a payment.")}
      />
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Section id="check" title={t("Check a message")}><ScamCheck endpoint="/safety/scan" demo={d.demo_message} tour="scam-scan" note={t("Four readers, strictest wins: a text model on this device, rules in code, an AI check (OpenAI Decisions) and code that compares any place to pay with your record. Green only when all of them ran and found nothing.")} /></Section>
        <Section id="how" title={t("How calls protect your customers")}>
          <Panel className="p-4">
            <ul className="space-y-3 text-sm">
              <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 flex-none text-done" /><span><b>{t("A code they can check.")}</b>{" "}{t("Every call opens with a four-digit code that's also on the customer's own page, so they can tell Callback from someone pretending to be you.")}</span></li>
              <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 flex-none text-done" /><span><b>{t("Never asks for secrets.")}</b>{" "}{t("Each line the agent is about to say is scanned; a line asking for a code, password or card number is replaced and counted.")}</span></li>
              <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 flex-none text-done" /><span><b>{t("Refunds go back where the money came from.")}</b>{" "}{t("A request to refund to a different account waits for you.")}</span></li>
              <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 flex-none text-done" /><span><b>{t("Nobody changes your payout details by message.")}</b>{" "}{t("A message claiming to be you and asking to move money is recorded and refused.")}</span></li>
            </ul>
          </Panel>
        </Section>
      </div>
      <Section id="protected" title={t("Protected mode")} hint={t("Every refund and discount waits for you, holds are explained calmly with no timers, and a trusted contact hears about each hold.")}>
        <Panel className="flex flex-col gap-3 p-4 md:flex-row md:items-end">
          <StateChip s={d.protected.on ? "done" : "idle"}>{d.protected.on ? t("On") : t("Off")}</StateChip>
          <div className="grid flex-1 gap-1.5"><Label htmlFor="pc1">{t("Trusted contact (Telegram chat id, optional)")}</Label><Input id="pc1" className="h-11" value={c1 ?? d.protected.contacts[0] ?? ""} onChange={(e) => setC1(e.target.value)} placeholder={t("telegram:123456789")} /></div>
          <div className="grid flex-1 gap-1.5"><Label htmlFor="pc2">{t("Second contact")}</Label><Input id="pc2" className="h-11" value={c2 ?? d.protected.contacts[1] ?? ""} onChange={(e) => setC2(e.target.value)} /></div>
          <ActButton path="/safety/protected" fields={{ on: d.protected.on ? "0" : "1", contact1: c1 ?? d.protected.contacts[0] ?? "", contact2: c2 ?? d.protected.contacts[1] ?? "" }} variant={d.protected.on ? "outline" : "default"} onDone={reload}>{d.protected.on ? t("Turn off") : t("Turn on")}</ActButton>
        </Panel>
      </Section>
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Section id="holds" title={t("Moves the scam guard paused")}>
          {d.holds.length ? (
            <ul className="space-y-2">{d.holds.map((h) => <li key={h.id}><Panel className="p-3 text-sm"><div className="flex items-center justify-between gap-2"><b>{h.action} {money(h.cents)}</b><StateChip s={h.status === "pending" ? "hold" : h.status === "approved" ? "done" : "off"}>{word(h.status)}</StateChip></div>{h.reasons.length ? <ul className="mt-1 list-disc pl-5 text-ink-2">{h.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}<div className="mt-1 text-xs text-ink-2 num">{when(h.created_at)}</div></Panel></li>)}</ul>
          ) : <Empty title={t("Nothing paused")}>{t("Payments that look like a scam stop here.")}</Empty>}
        </Section>
        <Section id="inbound" title={t("Messages received")}>
          {d.inbound.length ? (
            <ul className="space-y-2">{d.inbound.map((m, i) => <li key={i}><Panel className="p-3 text-sm"><div className="mb-1 flex items-center gap-2"><StateChip s={m.scan.level === "clear" ? "idle" : LEVEL[m.scan.level][0]}>{m.scan.level === "clear" ? (m.scan.all_clear_allowed ? t("No signs from the server checks") : t("Not fully checked")) : m.scan.level === "hold" ? t("Looks like a scam") : t("Check first")}</StateChip><span className="text-xs text-ink-2">{m.channel} · {when(m.created_at)}</span></div><p className="line-clamp-3">{m.body}</p>{m.scan.level !== "clear" && m.scan.reasons[0] ? <p className="mt-1 text-xs text-hold">{m.scan.reasons[0]}</p> : null}</Panel></li>)}</ul>
          ) : <Empty title={t("No messages yet")} />}
        </Section>
      </div>
    </>
  );
}
