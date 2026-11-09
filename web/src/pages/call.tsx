import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ExternalLink, Mic, MicOff, PhoneCall, PhoneOff, Play, RefreshCw, Send, SkipForward, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ActButton, Empty, ErrorState, Lamp, PageHead, Panel, Rows, Section, StateChip } from "@/components/app/bits";
import { CallScore, type Step, type Turn } from "@/components/app/call-score";
import { act } from "@/lib/api";
import { callLamp, LAMP_LABEL, money, moneyLamp, outcomeWord, PURPOSE, PURPOSE_VERB, when, word } from "@/lib/format";
import { useData, useSession, useTitle } from "@/lib/hooks";
import { useLiveVoice } from "@/lib/voice";

interface CallData {
  call: { id: string; status: string; purpose: string; outcome: string | null; reason: string | null; mode: string | null; transcript: Turn[]; consent_ok: boolean | null; hours_ok: boolean | null; breaches: number; collected_cents: number; started_at: string | null; ended_at: string | null; run_id: string | null; verify_code: string | null };
  customer: { id: string; name: string; tz: string; dnc: boolean; consent: any; token: string | null; phone_live: boolean };
  item: { id: string; title: string; kind: string; note: string; amount_cents: number; discount_cents: number; settled_cents: number; balance_cents: number; owed_to_customer_cents: number; status: string; due_local: string | null; appointment_local: string | null; captured: boolean; paypal_order_id: string | null; paypal_invoice_id: string | null; subscription_id: string | null } | null;
  offers: { discounts: { id: string; label: string; pct: number }[]; plans: { id: string; label: string }[]; slots: { id: string; label: string }[] } | null;
  money: { links: any[]; invoices: any[]; plans: any[]; refunds: any[] };
  approvals: { id: string; action: string; status: string; cents: number | null; reason: string }[];
  trace: Step[];
  events: { at: string; type: string; summary: string; actor: string }[];
  samples: string[];
  voice: { realtime: boolean; brain: string };
}
interface DemoData { personas: { id: string; purpose: string }[] }

function Check({ ok, label, no }: { ok: boolean | null; label: string; no: string }) {
  const s = ok === null ? "idle" : ok ? "done" : "off";
  return (
    <li className="flex items-start gap-2.5 py-2">
      <span className="lamp mt-1" data-s={s} aria-hidden="true" />
      <div><div className="text-sm font-medium">{label}</div><div className="text-xs text-ink-2">{ok === null ? "Checked when the call starts" : ok ? "Passed" : no}</div></div>
    </li>
  );
}

function MoneyTimeline({ d, owner, onChange }: { d: CallData; owner: boolean; onChange: () => void }) {
  const moves = [
    ...d.money.links.map((x) => ({ k: "Pay link", id: x.paypal_order_id, cents: Number(x.amount_cents), status: x.status, url: x.approve_url, at: x.created_at })),
    ...d.money.invoices.map((x) => ({ k: "Invoice", id: x.paypal_invoice_id, cents: Number(x.amount_cents), status: x.status, url: null, at: x.created_at })),
    ...d.money.plans.map((x) => ({ k: `Plan${x.option?.label ? `: ${x.option.label}` : ""}`, id: x.subscription_id, cents: Number(x.option?.per_cents ?? 0) * Number(x.option?.instalments ?? 1), status: x.status, url: x.approve_url, at: x.created_at })),
    ...d.money.refunds.map((x) => ({ k: "Refund", id: x.paypal_refund_id, cents: Number(x.amount_cents), status: x.status, url: null, at: x.created_at })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return (
    <Panel className="p-4" data-tour="money-lane-m">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="font-semibold">PayPal</h3>
        {owner ? <ActButton path="/ops/money/readback" size="sm" variant="ghost" icon={<RefreshCw />} onDone={onChange}>Read back</ActButton> : null}
      </div>
      {moves.length ? (
        <ol className="space-y-3">
          {moves.map((m, i) => (
            <li key={i} className="flex gap-3">
              <span className="lamp mt-1.5" data-s={moneyLamp(m.status)} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                  <span className="font-medium">{m.k}</span>
                  <span className="num font-medium">{money(m.cents)}</span>
                </div>
                <div className="text-sm text-ink-2">{word(m.status)} · {when(m.at)}</div>
                {m.id ? <div className="truncate font-mono text-xs text-ink-2">PayPal {m.id}</div> : null}
                {m.url && !["paid", "completed", "active"].includes(m.status) ? (
                  <a href={m.url} target="_blank" rel="noreferrer" className="mt-1 inline-flex min-h-10 items-center gap-1.5 text-sm font-medium text-brand underline-offset-4 hover:underline">
                    Open in PayPal sandbox <ExternalLink className="size-3.5" aria-hidden="true" />
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-ink-2">No PayPal moves yet. When the customer agrees, the gate checks the amount and creates the order here.</p>
      )}
      {d.item?.captured ? <p className="mt-3 rounded-[8px] bg-done-soft px-3 py-2 text-sm">Paid through PayPal: {money(d.item.settled_cents)} captured.</p> : null}
    </Panel>
  );
}

export default function CallPage() {
  const { id = "" } = useParams();
  const { session } = useSession();
  const owner = session?.me?.role === "owner";
  const { data: d, error, loading, reload } = useData<CallData>(`/api/app/calls/${id}`, { poll: 8000 });
  const { data: demo } = useData<DemoData>(session?.demo ? "/api/app/demo" : null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [persona, setPersona] = useState("");
  const voice = useLiveVoice(id, () => void reload());
  useTitle(d ? `Call: ${d.customer.name}` : "Call");

  if (error && !d) return <ErrorState error={error} retry={reload} />;
  if (loading && !d) return <Rows n={6} />;
  if (!d) return null;
  const c = d.call;
  const s = callLamp(c.status, c.outcome);
  const live = c.status === "in_progress" || c.status === "ringing";
  const canStart = c.status === "planned";
  const personas = (demo?.personas ?? []).filter((p) => p.purpose === c.purpose);
  const cents = d.item ? (d.item.kind === "class_cancel" ? d.item.owed_to_customer_cents : d.item.balance_cents) : null;

  const say = async (line: string) => {
    if (!line.trim()) return;
    setSending(true);
    try {
      const r = await act(`/calls/${id}/say`, { text: line });
      if (r.message) toast.success(r.message);
      setText("");
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <Link to="/calls" className="mb-3 inline-flex min-h-10 items-center gap-1.5 text-sm font-medium text-ink-2 hover:text-ink"><ArrowLeft className="size-4" />All calls</Link>
      <PageHead
        title={d.customer.name}
        kicker={<span className="inline-flex flex-wrap items-center gap-2"><StateChip s={s}>{c.status === "ended" ? outcomeWord(c.outcome) || "Ended" : LAMP_LABEL[s]}</StateChip><span>{PURPOSE[c.purpose]} · {d.item?.title}</span></span>}
        happened={c.status === "ended" ? `Call ended${c.ended_at ? ` ${when(c.ended_at)}` : ""}: ${outcomeWord(c.outcome) || "no outcome"}.${c.collected_cents ? ` ${money(c.collected_cents)} collected.` : ""}` : c.status === "blocked" ? `Not calling: ${c.reason}.` : live ? "The call is on the line." : "Planned. Nothing has been said yet."}
        needs={d.approvals.some((a) => a.status === "pending") ? <Link to="/approvals" className="font-medium text-hold underline underline-offset-4">A money move is waiting for you</Link> : undefined}
        next={canStart ? `${PURPOSE_VERB[c.purpose]}: ${money(cents)}.` : live ? "Type what the customer says, or play a persona." : undefined}
        actions={
          <>
            {canStart ? (
              <>
                <ActButton path={`/calls/${id}/place`} fields={{ mode: "simulator" }} icon={<Play />} onDone={reload}>Start in simulator</ActButton>
                {d.customer.phone_live ? <ActButton path={`/calls/${id}/place`} variant="outline" icon={<PhoneCall />} onDone={reload} confirmText={`Ring ${d.customer.name}'s real phone now?`}>Ring their phone</ActButton> : null}
                <ActButton path={`/calls/${id}/skip`} fields={{ reason: "skipped by staff" }} variant="ghost" icon={<SkipForward />} onDone={reload}>Skip</ActButton>
              </>
            ) : null}
            {live ? <ActButton path={`/calls/${id}/end`} variant="outline" icon={<PhoneOff />} onDone={reload}>End call</ActButton> : null}
            {session?.demo && owner && ["ended", "skipped", "blocked"].includes(c.status) ? (
              <ActButton path="/demo/call-again" fields={{ customer: d.customer.id }} variant="outline" icon={<RefreshCw />} follow>Call again (demo)</ActButton>
            ) : null}
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <div className="min-w-0">
          {live ? (
            <Panel className="mb-6 p-4" data-tour="call-sim">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Lamp s="live" showLabel label="On the line" />
                <span className="text-sm text-ink-2">Brain: {d.voice.brain === "model" ? "AI model, checked by rules" : "rules only"}</span>
                {c.verify_code ? <span className="ml-auto rounded-full bg-surface-2 px-2.5 py-1 font-mono text-xs">Verify code {c.verify_code}</span> : null}
              </div>
              <form onSubmit={(e) => { e.preventDefault(); void say(text); }} className="grid gap-2">
                <Label htmlFor="say">What the customer says</Label>
                <Textarea id="say" value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Yes, send me the link." className="min-h-[72px] text-base" onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void say(text); } }} />
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={sending || !text.trim()} aria-busy={sending}><Send /> Say it</Button>
                  {owner && d.voice.realtime ? (
                    <Button type="button" variant="outline" onClick={voice.start} aria-pressed={voice.state === "on"} disabled={voice.state === "starting"}>
                      {voice.state === "on" ? <MicOff /> : <Mic />}{voice.state === "on" ? "Stop live voice" : "Talk with your voice"}
                    </Button>
                  ) : null}
                </div>
                {voice.note ? <p role="status" className="text-sm text-ink-2">{voice.note}</p> : null}
              </form>
              {d.samples.length ? (
                <div className="mt-3">
                  <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-2">Try a line</div>
                  <div className="flex flex-wrap gap-2">
                    {d.samples.slice(0, 5).map((l) => (
                      <button key={l} type="button" onClick={() => void say(l)} disabled={sending} className="min-h-10 rounded-full border border-line bg-paper px-3 py-1.5 text-left text-sm hover:bg-surface-2">{l}</button>
                    ))}
                  </div>
                </div>
              ) : null}
            </Panel>
          ) : canStart && session?.demo && personas.length ? (
            <Panel className="mb-6 flex flex-col gap-3 p-4 sm:flex-row sm:items-end" data-tour="call-sim">
              <div className="grid flex-1 gap-1.5">
                <Label htmlFor="persona">Or play a whole scripted customer</Label>
                <Select value={persona} onValueChange={setPersona}>
                  <SelectTrigger id="persona" className="h-11 w-full"><SelectValue placeholder="Pick a persona" /></SelectTrigger>
                  <SelectContent>{personas.map((p) => <SelectItem key={p.id} value={p.id}>{p.id.replace(/[-_]/g, " ")}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <ActButton path="/demo/persona" fields={{ persona, call: id }} disabled={!persona} variant="outline" icon={<Sparkles />} onDone={reload}>Play persona</ActButton>
            </Panel>
          ) : null}

          <Section id="score" title="Call score" hint="Voice, rules and money on one time line.">
            <CallScore transcript={c.transcript} trace={d.trace} empty={canStart ? "Start the call to see it unfold here." : undefined} />
            {c.run_id ? <Link to={`/trace/${c.run_id}`} className="mt-2 inline-block text-sm font-medium text-brand underline-offset-4 hover:underline">Open the full trace</Link> : null}
          </Section>
        </div>

        <aside className="space-y-4">
          {d.item ? (
            <Panel className="p-4">
              <div className="text-sm text-ink-2">{d.item.kind === "class_cancel" ? "Owed to the customer" : "Owed"}</div>
              <div className="font-display text-[2rem] font-[800] leading-none num">{money(cents)}</div>
              <div className="mt-2 text-sm">{d.item.title}</div>
              <div className="text-sm text-ink-2">{d.item.due_local ? `Due ${d.item.due_local}` : d.item.appointment_local ? `Booking ${d.item.appointment_local}` : ""}</div>
              {d.item.note ? <div className="mt-1 text-sm text-ink-2">Note: {d.item.note}</div> : null}
              <div className="mt-2"><StateChip s={moneyLamp(d.item.status)}>{word(d.item.status)}</StateChip></div>
            </Panel>
          ) : null}
          <MoneyTimeline d={d} owner={owner} onChange={reload} />
          <Panel className="p-4">
            <h3 className="font-semibold">Checks before calling</h3>
            <ul className="divide-y divide-line">
              <Check ok={c.consent_ok} label="Consent on file" no="No consent: never called" />
              <Check ok={c.hours_ok} label={`Calling hours in ${d.customer.tz.split("/").pop()?.replace(/_/g, " ")}`} no="Outside their calling hours" />
              <Check ok={!d.customer.dnc} label="Hasn't asked us to stop" no="Asked not to be called" />
              <Check ok={c.breaches === 0} label="No rule broken on the call" no={`${c.breaches} attempt${c.breaches === 1 ? "" : "s"} refused by the gate`} />
            </ul>
          </Panel>
          {d.offers ? (
            <Panel className="p-4">
              <h3 className="font-semibold">What it may offer</h3>
              <p className="mb-2 text-xs text-ink-2">Only these, set by your rules.</p>
              <ul className="space-y-1 text-sm">
                {d.offers.discounts.map((x) => <li key={x.id}>Discount: {x.label}</li>)}
                {d.offers.plans.map((x) => <li key={x.id}>Plan: {x.label}</li>)}
                {d.offers.slots.length ? <li>Call-back times: {d.offers.slots.length}</li> : null}
                {!d.offers.discounts.length && !d.offers.plans.length ? <li className="text-ink-2">No discounts or plans for this one.</li> : null}
              </ul>
            </Panel>
          ) : null}
          <Panel className="p-4">
            <h3 className="font-semibold">Customer</h3>
            <p className="text-sm text-ink-2">{d.customer.tz}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild><Link to={`/customers/${d.customer.id}`}>Customer record</Link></Button>
              {d.customer.token ? <Button variant="outline" size="sm" asChild><Link to={`/c/${d.customer.token}`}>Their page</Link></Button> : null}
            </div>
          </Panel>
          {d.events.length ? (
            <Panel className="p-4">
              <h3 className="mb-2 font-semibold">Events</h3>
              <ul className="space-y-1.5 text-sm">{d.events.slice(0, 8).map((e, i) => <li key={i}><span className="text-xs text-ink-2 num">{when(e.at)}</span> {e.summary}</li>)}</ul>
            </Panel>
          ) : <Empty title="No events yet" />}
        </aside>
      </div>
    </>
  );
}
