import { useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, FlaskConical, RefreshCw, Webhook } from "lucide-react";
import { ActButton, Empty, ErrorState, Kpi, PageHead, Panel, Rows, Section, Segmented, StateChip } from "@/components/app/bits";
import { NativeSelect } from "@/components/app/form";
import { money, moneyLamp, when, word } from "@/lib/format";
import { useData, useTitle } from "@/lib/hooks";
import { useStatusAnnouncer } from "@/lib/announce";

import { num, t, tlist, tmap } from "@/i18n";
interface Move { kind: string; id: string; at: string; cents: number; label?: string; paypal_id: string | null; status: string; approve_url: string | null; item: string; customer: string; customer_id: string | null; call_id: string | null }
interface HoldRow { id: string; status: string; cents: number; order_id: string | null; authorization_id: string | null; capture_id: string | null; expires_at: string | null; via: string; item: string; customer: string; call_id: string | null; appointment_at: string | null }
interface MoneyData {
  holds: HoldRow[];
  totals: { owed_cents: number; paid_cents: number; owed_back_cents: number; refunded_cents: number };
  moves: Move[]; captures: { item: string; customer: string; capture_id: string; cents: number; status: string }[];
  hooks: { event_type: string; verified: boolean; received_at: string }[];
  balances: { currency: string; value: string }[];
  paypal: { configured: boolean; env: string; readable: boolean };
  webhook_events: string[]; faultable: string[];
}
const KIND: Record<string, string> = tmap({ pay_link: "Pay link", invoice: "Invoice", plan: "Plan", refund: "Refund", hold: "Hold" });
const KINDS: Record<string, string> = tmap({ pay_link: "Pay links", invoice: "Invoices", plan: "Plans", refund: "Refunds", hold: "Holds" });
const NEG = tlist([
  { v: "capture_declined", l: "Capture comes back DECLINED" },
  { v: "order_voided", l: "Order reads back as VOIDED" },
  { v: "refund_422", l: "Refund rejected (422)" },
  { v: "invoice_404", l: "Invoice not found" },
], ["l"]);

export default function MoneyPage() {
  useTitle(t("Money"));
  const { data: d, error, loading, reload } = useData<MoneyData>("/api/app/money", { poll: 20000 });
  // Status changes found by the poll are said once through the app's polite live region (spec A7).
  useStatusAnnouncer(d?.moves, (m) => `${m.kind}:${m.id}`, (m) => m.status, (m) => `${m.customer}, ${m.item}`, word);
  useStatusAnnouncer(d?.holds, (h) => h.id, (h) => h.status, (h) => t("{customer}, hold for {item}", { customer: h.customer, item: h.item }), (s) => (s === "authorized" ? t("held, not charged") : s === "captured" ? t("charged") : s === "voided" ? t("released") : word(s)));
  const [f, setF] = useState("all");
  const [neg, setNeg] = useState(NEG[0].v);
  const [hook, setHook] = useState("");
  if (error && !d) return <ErrorState error={error} retry={reload} />;
  if (loading && !d) return <Rows n={5} />;
  if (!d) return null;
  const moves = d.moves.filter((m) => f === "all" || m.kind === f);
  const waiting = d.moves.filter((m) => moneyLamp(m.status) === "ready").length;
  return (
    <>
      <div data-tour="money">
      <PageHead
        title={t("Money")}
        kicker={d.paypal.configured ? <StateChip s={d.paypal.readable ? "live" : "hold"}>{t("PayPal")}{" "}{d.paypal.env}{d.paypal.readable ? t(" · connected") : t(" · can't read right now")}</StateChip> : <StateChip s="off">{t("PayPal not configured")}</StateChip>}
        happened={t("{0} paid, {1} refunded.", [money(d.totals.paid_cents), money(d.totals.refunded_cents)])}
        needs={d.totals.owed_back_cents ? t("{0} is owed back to customers for cancelled bookings.", [money(d.totals.owed_back_cents)]) : undefined}
        next={waiting ? t("Links or invoices waiting for the customer to pay: {0}.", [waiting]) : t("Nothing waiting on customers.")}
        actions={<ActButton path="/ops/money/readback" variant="outline" icon={<RefreshCw />} onDone={reload}>{t("Read back from PayPal")}</ActButton>}
      />
      </div>
      <div className="kpi-grid mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={t("Owed to you")} value={money(d.totals.owed_cents)} s="ready" />
        <Kpi label={t("Paid")} value={money(d.totals.paid_cents)} s="done" />
        <Kpi label={t("Owed back")} value={money(d.totals.owed_back_cents)} s={d.totals.owed_back_cents ? "hold" : "idle"} />
        <Kpi label={t("PayPal balance")} value={d.balances.length ? (d.balances.length === 1 ? `${d.balances[0].currency} ${num(Number(d.balances[0].value), { minimumFractionDigits: 2 })}` : <span className="flex flex-col gap-1 text-lg leading-tight">{d.balances.map((b) => <span key={b.currency} className="break-all">{b.currency} {num(Number(b.value), { minimumFractionDigits: 2 })}</span>)}</span>) : "—"} hint={d.paypal.readable ? t("Sandbox merchant, read live") : t("Not readable")} />
      </div>
      <Section id="moves" title={t("Every money move")} hint={t("Read back from PayPal, newest first.")}>
        <Segmented className="mb-3" label={t("Show money moves")} value={f} onChange={setF} options={["all", "pay_link", "hold", "invoice", "plan", "refund"].map((k) => ({ v: k, label: <>{k === "all" ? t("All") : KINDS[k]}<span className="ml-1 text-xs num">{d.moves.filter((m) => k === "all" || m.kind === k).length}</span></> }))} />
        {moves.length ? (
          <ul className="divide-y divide-line overflow-hidden rounded-[14px] border border-line bg-surface">
            {moves.map((m) => (
              <li key={`${m.kind}-${m.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="lamp" data-s={moneyLamp(m.status)} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{KIND[m.kind]}{m.label ? `: ${m.label}` : ""} · {m.customer}</div>
                  <div className="text-sm text-ink-2">{word(m.status)} · {m.item} · {when(m.at)}</div>
                  {m.paypal_id ? <div className="truncate font-mono text-xs text-ink-2">{t("PayPal")}{" "}{m.paypal_id}</div> : null}
                </div>
                <div className="num font-medium">{money(m.cents)}</div>
                <div className="flex gap-2">
                  {m.approve_url && moneyLamp(m.status) !== "done" ? <a href={m.approve_url} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1 text-sm font-medium text-brand underline-offset-4 hover:underline">{t("PayPal")}{" "}<ExternalLink className="size-3.5" /></a> : null}
                  {m.call_id ? <Link to={`/calls/${m.call_id}`} className="inline-flex min-h-10 items-center text-sm font-medium text-brand underline-offset-4 hover:underline">{t("Call")}</Link> : null}
                </div>
              </li>
            ))}
          </ul>
        ) : <Empty title={t("No money moves yet")}>{t("They appear here when a call sends a pay link, an invoice, a plan or a refund.")}</Empty>}
      </Section>
      <Section id="holds" title={t("Deposit holds")} hint={t("Held on the customer's PayPal, not charged. Charge after they attend; release if they cancelled in time.")}>
        {d.holds.filter((h) => h.status !== "failed").length ? (
          <ul className="divide-y divide-line overflow-hidden rounded-[14px] border border-line bg-surface">
            {d.holds.filter((h) => h.status !== "failed").map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="lamp" data-s={h.status === "authorized" ? "live" : h.status === "captured" ? "done" : h.status === "link_sent" ? "ready" : "idle"} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{h.customer} · {h.item}</div>
                  <div className="text-sm text-ink-2">{h.status === "authorized" ? t("Held, not charged") : h.status === "link_sent" ? t("Hold link sent, waiting for the customer") : h.status === "captured" ? t("Charged after they attended") : h.status === "voided" ? t("Released: cancelled in time") : word(h.status)}{h.appointment_at ? t(" · appointment {0}", [when(h.appointment_at)]) : ""}</div>
                  {h.authorization_id ? <div className="truncate font-mono text-xs text-ink-2">{t("Authorization")}{" "}{h.authorization_id}{h.capture_id ? t(" · capture {0}", [h.capture_id]) : ""}</div> : null}
                </div>
                <div className="num font-medium">{money(h.cents)}</div>
                {h.status === "authorized" ? (
                  <div className="flex flex-wrap gap-2">
                    <ActButton path={`/holds/${h.id}/capture`} onDone={reload} confirmText={t("Charge {name} {amount} from the hold?", { name: h.customer, amount: money(h.cents) })}>{t("Attended: charge")}</ActButton>
                    <ActButton path={`/holds/${h.id}/void`} variant="outline" onDone={reload} confirmText={t("Release the {amount} hold for {name}?", { name: h.customer, amount: money(h.cents) })}>{t("Cancelled in time: release")}</ActButton>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : <Empty title={t("No holds yet")}>{t("A deposit call can offer a hold next to paying now; the customer can also hold it from their page.")}</Empty>}
      </Section>
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Section id="captures" title={t("Payments captured")}>
          {d.captures.length ? (
            <ul className="space-y-2">{d.captures.map((c) => <li key={c.capture_id}><Panel className="flex items-center gap-3 p-3 text-sm"><span className="lamp" data-s={moneyLamp(c.status)} aria-hidden="true" /><div className="min-w-0 flex-1"><div className="font-medium">{c.customer} · {c.item}</div><div className="truncate font-mono text-xs text-ink-2">{t("Capture")}{" "}{c.capture_id}</div></div><span className="num font-medium">{money(c.cents)}</span></Panel></li>)}</ul>
          ) : <Empty title={t("No captures yet")}>{t("Pay a link as the sandbox buyer, then read back.")}</Empty>}
        </Section>
        <Section id="test" title={t("When PayPal misbehaves")} hint={t("Runs a money move against a canned PayPal reply, to show the agent stays honest.")}>
          <Panel className="space-y-4 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1"><NativeSelect id="neg" label={t("Failure")} value={neg} onChange={(e) => setNeg(e.target.value)}>{NEG.map((n) => <option key={n.v} value={n.v}>{n.l}</option>)}</NativeSelect></div>
              <ActButton path="/ops/money/negative" fields={{ case: neg }} variant="outline" icon={<FlaskConical />} onDone={reload}>{t("Run it")}</ActButton>
            </div>
            {d.paypal.configured ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="min-w-0 flex-1"><NativeSelect id="hook" label={t("Simulate a sandbox webhook")} value={hook || d.webhook_events[0]} onChange={(e) => setHook(e.target.value)}>{d.webhook_events.map((e) => <option key={e}>{e}</option>)}</NativeSelect></div>
                <ActButton path="/ops/money/webhook/simulate" fields={{ event: hook || d.webhook_events[0] }} variant="outline" icon={<Webhook />} onDone={reload}>{t("Send")}</ActButton>
              </div>
            ) : null}
            <div>
              <h4 className="mb-1 text-sm font-semibold">{t("Webhooks received")}</h4>
              {d.hooks.length ? <ul className="space-y-1 text-sm">{d.hooks.map((h, i) => <li key={i} className="flex items-center gap-2"><span className="lamp scale-75" data-s={h.verified ? "done" : "hold"} aria-hidden="true" /><span className="flex-1 font-mono text-xs">{h.event_type}</span><span className="text-xs text-ink-2">{h.verified ? t("verified") : t("unverified")} · {when(h.received_at)}</span></li>)}</ul> : <p className="text-sm text-ink-2">{t("None yet.")}</p>}
            </div>
          </Panel>
        </Section>
      </div>
    </>
  );
}
