import { useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, FlaskConical, RefreshCw, Webhook } from "lucide-react";
import { ActButton, Empty, ErrorState, Kpi, PageHead, Panel, Rows, Section, Segmented, StateChip } from "@/components/app/bits";
import { NativeSelect } from "@/components/app/form";
import { money, moneyLamp, when, word } from "@/lib/format";
import { useData, useTitle } from "@/lib/hooks";

interface Move { kind: string; id: string; at: string; cents: number; label?: string; paypal_id: string | null; status: string; approve_url: string | null; item: string; customer: string; customer_id: string | null; call_id: string | null }
interface MoneyData {
  totals: { owed_cents: number; paid_cents: number; owed_back_cents: number; refunded_cents: number };
  moves: Move[]; captures: { item: string; customer: string; capture_id: string; cents: number; status: string }[];
  hooks: { event_type: string; verified: boolean; received_at: string }[];
  balances: { currency: string; value: string }[];
  paypal: { configured: boolean; env: string; readable: boolean };
  webhook_events: string[]; faultable: string[];
}
const KIND: Record<string, string> = { pay_link: "Pay link", invoice: "Invoice", plan: "Plan", refund: "Refund" };
const NEG = [
  { v: "capture_declined", l: "Capture comes back DECLINED" },
  { v: "order_voided", l: "Order reads back as VOIDED" },
  { v: "refund_422", l: "Refund rejected (422)" },
  { v: "invoice_404", l: "Invoice not found" },
];

export default function MoneyPage() {
  useTitle("Money");
  const { data: d, error, loading, reload } = useData<MoneyData>("/api/app/money", { poll: 20000 });
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
      <PageHead
        title="Money"
        kicker={d.paypal.configured ? <StateChip s={d.paypal.readable ? "live" : "hold"}>PayPal {d.paypal.env}{d.paypal.readable ? " · connected" : " · can't read right now"}</StateChip> : <StateChip s="off">PayPal not configured</StateChip>}
        happened={`${money(d.totals.paid_cents)} paid, ${money(d.totals.refunded_cents)} refunded.`}
        needs={d.totals.owed_back_cents ? `${money(d.totals.owed_back_cents)} is owed back to customers for cancelled bookings.` : undefined}
        next={waiting ? `${waiting} link${waiting === 1 ? "" : "s"} or invoice${waiting === 1 ? "" : "s"} waiting for the customer to pay.` : "Nothing waiting on customers."}
        actions={<ActButton path="/ops/money/readback" variant="outline" icon={<RefreshCw />} onDone={reload}>Read back from PayPal</ActButton>}
      />
      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Owed to you" value={money(d.totals.owed_cents)} s="ready" />
        <Kpi label="Paid" value={money(d.totals.paid_cents)} s="done" />
        <Kpi label="Owed back" value={money(d.totals.owed_back_cents)} s={d.totals.owed_back_cents ? "hold" : "idle"} />
        <Kpi label="PayPal balance" value={d.balances.length ? d.balances.map((b) => `${b.currency} ${Number(b.value).toLocaleString("en-US", { minimumFractionDigits: 2 })}`).join(" · ") : "—"} hint={d.paypal.readable ? "Sandbox merchant, read live" : "Not readable"} />
      </div>
      <Section id="moves" title="Every money move" hint="Read back from PayPal, newest first.">
        <Segmented className="mb-3" label="Show money moves" value={f} onChange={setF} options={["all", "pay_link", "invoice", "plan", "refund"].map((k) => ({ v: k, label: <>{k === "all" ? "All" : `${KIND[k]}s`}<span className="ml-1 text-xs num">{d.moves.filter((m) => k === "all" || m.kind === k).length}</span></> }))} />
        {moves.length ? (
          <ul className="divide-y divide-line overflow-hidden rounded-[10px] border border-line bg-surface">
            {moves.map((m) => (
              <li key={`${m.kind}-${m.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="lamp" data-s={moneyLamp(m.status)} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{KIND[m.kind]}{m.label ? `: ${m.label}` : ""} · {m.customer}</div>
                  <div className="text-sm text-ink-2">{word(m.status)} · {m.item} · {when(m.at)}</div>
                  {m.paypal_id ? <div className="truncate font-mono text-xs text-ink-2">PayPal {m.paypal_id}</div> : null}
                </div>
                <div className="num font-medium">{money(m.cents)}</div>
                <div className="flex gap-2">
                  {m.approve_url && moneyLamp(m.status) !== "done" ? <a href={m.approve_url} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1 text-sm font-medium text-brand underline-offset-4 hover:underline">PayPal <ExternalLink className="size-3.5" /></a> : null}
                  {m.call_id ? <Link to={`/calls/${m.call_id}`} className="inline-flex min-h-10 items-center text-sm font-medium text-brand underline-offset-4 hover:underline">Call</Link> : null}
                </div>
              </li>
            ))}
          </ul>
        ) : <Empty title="No money moves yet">They appear here when a call sends a pay link, an invoice, a plan or a refund.</Empty>}
      </Section>
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Section id="captures" title="Payments captured">
          {d.captures.length ? (
            <ul className="space-y-2">{d.captures.map((c) => <li key={c.capture_id}><Panel className="flex items-center gap-3 p-3 text-sm"><span className="lamp" data-s={moneyLamp(c.status)} aria-hidden="true" /><div className="min-w-0 flex-1"><div className="font-medium">{c.customer} · {c.item}</div><div className="truncate font-mono text-xs text-ink-2">Capture {c.capture_id}</div></div><span className="num font-medium">{money(c.cents)}</span></Panel></li>)}</ul>
          ) : <Empty title="No captures yet">Pay a link as the sandbox buyer, then read back.</Empty>}
        </Section>
        <Section id="test" title="When PayPal misbehaves" hint="Runs a money move against a canned PayPal reply, to show the agent stays honest.">
          <Panel className="space-y-4 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1"><NativeSelect id="neg" label="Failure" value={neg} onChange={(e) => setNeg(e.target.value)}>{NEG.map((n) => <option key={n.v} value={n.v}>{n.l}</option>)}</NativeSelect></div>
              <ActButton path="/ops/money/negative" fields={{ case: neg }} variant="outline" icon={<FlaskConical />} onDone={reload}>Run it</ActButton>
            </div>
            {d.paypal.configured ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="min-w-0 flex-1"><NativeSelect id="hook" label="Simulate a sandbox webhook" value={hook || d.webhook_events[0]} onChange={(e) => setHook(e.target.value)}>{d.webhook_events.map((e) => <option key={e}>{e}</option>)}</NativeSelect></div>
                <ActButton path="/ops/money/webhook/simulate" fields={{ event: hook || d.webhook_events[0] }} variant="outline" icon={<Webhook />} onDone={reload}>Send</ActButton>
              </div>
            ) : null}
            <div>
              <h4 className="mb-1 text-sm font-semibold">Webhooks received</h4>
              {d.hooks.length ? <ul className="space-y-1 text-sm">{d.hooks.map((h, i) => <li key={i} className="flex items-center gap-2"><span className="lamp scale-75" data-s={h.verified ? "done" : "hold"} aria-hidden="true" /><span className="flex-1 font-mono text-xs">{h.event_type}</span><span className="text-xs text-ink-2">{h.verified ? "verified" : "unverified"} · {when(h.received_at)}</span></li>)}</ul> : <p className="text-sm text-ink-2">None yet.</p>}
            </div>
          </Panel>
        </Section>
      </div>
    </>
  );
}
