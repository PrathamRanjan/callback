import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { CalendarClock, CreditCard, Gift, MessageCircle, PhoneOff, ShieldCheck, Undo2 } from "lucide-react";
import { ActButton, Empty, ErrorState, Panel, Rows, StateChip } from "@/components/app/bits";
import { PublicShell } from "@/components/app/public-shell";
import { NativeSelect } from "@/components/app/form";
import { money, moneyLamp, word } from "@/lib/format";
import { useData, useTitle } from "@/lib/hooks";

interface PortalData {
  business: { name: string }; first_name: string; tz: string; verify_code: string | null; last_call_at: string | null;
  open: { id: string; kind: string; title: string; note: string; balance_cents: number; owed_to_you_cents: number; discount_cents: number; status: string; due_local: string | null; appointment_local: string | null; paid_by_paypal: boolean; plans: { id: string; label: string }[] }[];
  settled: { id: string; title: string; status: string; cents: number; capture_id: string | null; via_wallet: boolean }[];
  demo_wallet: boolean;
  messages: { body: string; channel: string; created_at: string }[];
  calls: { dnc: boolean; consent: { granted_on: string; revoked: boolean } | null; hours: { start: string; end: string }; slots: { at: string; label: string }[] };
  telegram: string;
}

/** Split an invoice into one of the plans the business's rules allow; PayPal opens to approve the subscription. */
function PlanPicker({ token, item, plans }: { token: string; item: string; plans: { id: string; label: string }[] }) {
  const [option, setOption] = useState(plans[0]?.id ?? "");
  const id = `plan-${item}`;
  return (
    <div className="mt-3 rounded-[10px] border border-line bg-surface-2 p-3" data-tour="portal-plan">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <NativeSelect id={id} label="Or split it into payments" value={option} onChange={(e) => setOption(e.target.value)}>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </NativeSelect>
        </div>
        <ActButton path={`/c/${token}/plan/${item}`} fields={{ option }} variant="outline" icon={<CalendarClock />} className="h-12">Set up plan with PayPal</ActButton>
      </div>
    </div>
  );
}

/** The customer's own page. Plain words, one job per card, big buttons; nothing about other customers. */
export default function PortalPage() {
  const { token = "" } = useParams();
  const { data: d, error, loading, reload } = useData<PortalData>(`/api/app/c/${token}`);
  const [slot, setSlot] = useState("");
  const [q] = useSearchParams();
  const back = q.get("paid") ? "Thanks: PayPal has your payment. It shows here as paid once PayPal confirms it." : q.get("plan") ? "Your payment plan is approved." : null;
  useTitle(d ? `${d.business.name}: your account` : "Your account");
  return (
    <PublicShell>
      <div className="mx-auto max-w-[560px] px-4 py-8" data-tour="portal">
        {error && !d ? <ErrorState error={error} retry={reload} /> : loading && !d ? <Rows n={3} /> : d ? (
          <>
            <p className="text-sm text-ink-2">{d.business.name}</p>
            <h1 className="font-display text-h1 font-[800]" style={{ fontStretch: "112%" }}>Hi {d.first_name}</h1>
            {back ? <p role="status" className="mt-4 rounded-[10px] bg-done-soft px-4 py-3 text-sm font-medium">{back}</p> : null}
            {d.verify_code ? (
              <Panel className="mt-4 flex items-center gap-3 border-brand/40 bg-brand-soft p-4">
                <ShieldCheck className="size-6 flex-none" aria-hidden="true" />
                <div>
                  <div className="text-sm">Our last call gave you this code. If someone calls claiming to be us and can't say it, hang up.</div>
                  <div className="font-mono text-[1.6rem] font-semibold tracking-[0.3em] num">{d.verify_code}</div>
                </div>
              </Panel>
            ) : null}
            <h2 className="mt-8 text-xl font-semibold">What's open</h2>
            <div className="mt-3 space-y-3">
              {d.open.length ? d.open.map((o) => (
                <Panel key={o.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium">{o.title}</div>
                      <div className="text-sm text-ink-2">{o.due_local ? `Due ${o.due_local}` : o.appointment_local ? `Booking ${o.appointment_local}` : ""}</div>
                      {o.note ? <div className="mt-1 text-sm">Sorry: {o.note}.</div> : null}
                    </div>
                    <div className="text-right">
                      <div className="font-display text-[1.6rem] font-[800] leading-none num">{money(o.kind === "class_cancel" ? o.owed_to_you_cents : o.balance_cents)}</div>
                      <div className="text-xs text-ink-2">{o.kind === "class_cancel" ? "we owe you" : "to pay"}</div>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {o.kind === "class_cancel" ? (
                      <>
                        <span className="flex flex-1" data-tour="portal-refund"><ActButton path={`/c/${token}/settle/${o.id}`} fields={{ choice: "refund" }} icon={<Undo2 />} onDone={reload} className="h-12 flex-1">Refund {money(o.owed_to_you_cents)}{o.paid_by_paypal ? " to PayPal" : ""}</ActButton></span>
                        <ActButton path={`/c/${token}/settle/${o.id}`} fields={{ choice: "credit" }} variant="outline" icon={<Gift />} onDone={reload} className="h-12 flex-1">Keep as class credit</ActButton>
                      </>
                    ) : o.balance_cents > 0 ? (
                      <div className="grid w-full gap-2">
                        {d.demo_wallet ? (
                          <span data-tour="portal-wallet"><ActButton path={`/c/${token}/wallet/${o.id}`} icon={<CreditCard />} onDone={reload} className="h-12 w-full">Pay {money(o.balance_cents)} as the demo customer (saved PayPal, no login)</ActButton></span>
                        ) : null}
                        <ActButton path={`/c/${token}/pay/${o.id}`} variant={d.demo_wallet ? "outline" : "default"} icon={<CreditCard />} onDone={reload} className="h-12 w-full">Pay {money(o.balance_cents)} on PayPal's own page</ActButton>
                        {d.demo_wallet ? <p className="text-xs text-ink-2">Demo: the first button pays from the demo's saved sandbox PayPal wallet, so no PayPal sign-in is needed. It is a real sandbox payment; nothing real is charged.</p> : null}
                      </div>
                    ) : <StateChip s={moneyLamp(o.status)}>{word(o.status)}</StateChip>}
                  </div>
                  {o.kind === "class_cancel" && !o.paid_by_paypal ? <p className="mt-2 text-xs text-ink-2">You paid outside PayPal, so a refund comes back the same way you paid.</p> : null}
                  {o.status === "planned" ? <p className="mt-2 text-sm"><StateChip s="live">Payment plan set up</StateChip> <span className="text-ink-2">Approve it with PayPal from the link we sent, or pay in full above.</span></p> : null}
                  {o.plans.length ? <PlanPicker token={token} item={o.id} plans={o.plans} /> : null}
                </Panel>
              )) : <Empty title="Nothing to pay">You're all square with {d.business.name}.</Empty>}
            </div>

            <h2 className="mt-8 text-xl font-semibold">Calls from us</h2>
            <Panel className="mt-3 space-y-3 p-4">
              {d.calls.dnc || !d.calls.consent || d.calls.consent.revoked ? (
                <p className="flex items-center gap-2"><PhoneOff className="size-4" />We won't call you. Your choice is saved.</p>
              ) : (
                <>
                  <p className="text-sm text-ink-2">We only call between {d.calls.hours.start} and {d.calls.hours.end}, your time. You agreed on {d.calls.consent.granted_on}.</p>
                  {d.calls.slots.length ? (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                      <div className="flex-1"><NativeSelect id="slot" label="Call me back at" value={slot || d.calls.slots[0].at} onChange={(e) => setSlot(e.target.value)}>{d.calls.slots.map((s) => <option key={s.at} value={s.at}>{s.label}</option>)}</NativeSelect></div>
                      <ActButton path={`/c/${token}/callback`} fields={{ at: slot || d.calls.slots[0].at }} variant="outline" icon={<CalendarClock />} onDone={reload} className="h-11">Book it</ActButton>
                    </div>
                  ) : null}
                  <ActButton path={`/c/${token}/stop`} variant="ghost" icon={<PhoneOff />} confirmText={`Stop all calls from ${d.business.name}?`} onDone={reload}>Stop calling me</ActButton>
                </>
              )}
            </Panel>

            <a href={d.telegram} className="mt-4 flex min-h-12 items-center justify-center gap-2 rounded-[10px] border border-line bg-surface px-4 text-sm font-medium hover:bg-surface-2" target="_blank" rel="noreferrer">
              <MessageCircle className="size-4" /> Get updates on Telegram instead
            </a>

            {d.messages.length ? (
              <>
                <h2 className="mt-8 text-xl font-semibold">Messages from us</h2>
                <ul className="mt-3 space-y-2">{d.messages.map((m, k) => <li key={k} className="break-words rounded-[10px] bg-brand-soft px-3 py-2 text-sm [overflow-wrap:anywhere]">{m.body}<div className="mt-0.5 text-[0.7rem] text-ink-2">{m.channel}</div></li>)}</ul>
              </>
            ) : null}
            {d.settled.length ? (
              <>
                <h2 className="mt-8 text-xl font-semibold">Done</h2>
                <ul className="mt-3 divide-y divide-line rounded-[10px] border border-line bg-surface">{d.settled.map((s) => <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm"><span className="lamp" data-s={moneyLamp(s.status)} aria-hidden="true" /><span className="flex-1">{s.title}</span><span className="text-ink-2">{word(s.status)}</span><span className="num font-medium">{money(s.cents)}</span>{s.capture_id ? <span className="basis-full text-xs text-ink-2">PayPal capture <span className="font-mono">{s.capture_id}</span>{s.via_wallet ? ", paid from the demo's saved sandbox wallet" : ""}</span> : null}</li>)}</ul>
              </>
            ) : null}
            <p className="mt-8 text-xs text-ink-2">This page is only for you. {d.business.name} will never ask for a password, a one-time code or your card number.</p>
          </>
        ) : null}
      </div>
    </PublicShell>
  );
}
