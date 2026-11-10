import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Ban, CirclePlus, ExternalLink, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ActButton, Empty, ErrorState, PageHead, Panel, Rows, Section, StateChip } from "@/components/app/bits";
import { ActionDialog, Field, NativeSelect } from "@/components/app/form";
import { useData, useSession, useTitle } from "@/lib/hooks";
import { callLamp, money, moneyLamp, outcomeWord, PURPOSE, when, word } from "@/lib/format";

interface Item { id: string; kind: string; title: string; note: string; amount_cents: number; discount_cents: number; settled_cents: number; balance_cents: number; owed_to_customer_cents: number; status: string; due_local: string | null; appointment_local: string | null; captured: boolean; can_cancel: boolean }
interface CustomerData {
  customer: { id: string; name: string; phone: string; email: string | null; tz: string; notes: string; dnc: boolean; consent: { granted_at: string; source: string; text: string; revoked_at: string | null } | null; link: string | null };
  items: Item[];
  calls: { id: string; status: string; purpose: string; outcome: string | null; reason: string | null; created_at: string }[];
  events: { at: string; type: string; summary: string; actor: string }[];
}
const KIND: Record<string, string> = { deposit: "Deposit", invoice: "Invoice", class_cancel: "Cancelled booking" };
const iso = (v: string) => (v ? new Date(v).toISOString() : "");

function NewCharge({ id, onDone }: { id: string; onDone: () => void }) {
  const [kind, setKind] = useState("deposit");
  return (
    <ActionDialog
      trigger={<Button><CirclePlus /> New charge</Button>}
      title="New charge"
      description="Callback re-plans its calls straight after. Times are in your device's time zone."
      path={`/customers/${id}/charges`}
      submit="Add charge"
      onDone={onDone}
      transform={(f) => ({ ...f, due_at: iso(f.due_at), appointment_at: iso(f.appointment_at ?? "") })}
    >
      <NativeSelect id="kind" label="What is it?" value={kind} onChange={(e) => setKind(e.target.value)}>
        <option value="deposit">Deposit before a booking</option>
        <option value="invoice">Invoice</option>
      </NativeSelect>
      <Field id="title" label="Description" required placeholder={kind === "deposit" ? "Thursday 7am reformer class" : "Five-class pack"} />
      <Field id="amount" label="Amount in dollars" required inputMode="decimal" placeholder="60.00" hint="Up to $10,000.00." />
      <Field id="due_at" label={kind === "deposit" ? "Deposit due" : "Invoice due"} type="datetime-local" required />
      {kind === "deposit" ? <Field id="appointment_at" label="Booking starts" type="datetime-local" required /> : null}
      <div className="grid gap-1.5">
        <Label htmlFor="note">Note (optional)</Label>
        <Textarea id="note" name="note" rows={2} />
      </div>
    </ActionDialog>
  );
}

function CancelBooking({ item, onDone }: { item: Item; onDone: () => void }) {
  return (
    <ActionDialog
      trigger={<Button variant="outline" size="sm" data-tour="cancel-booking"><Ban /> Cancel booking</Button>}
      title={`Cancel ${item.title}?`}
      description={`Callback will call to offer a ${money(item.settled_cents)} refund${item.captured ? " back to their PayPal" : " (paid outside PayPal, so you pay it back by hand)"} or a class credit. Refunds wait for your approval if they're over your limit.`}
      path={`/obligations/${item.id}/cancel`}
      submit="Cancel the booking"
      onDone={onDone}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="reason">Reason Callback will give</Label>
        <Textarea id="reason" name="reason" rows={2} required placeholder="The instructor is unwell" />
      </div>
    </ActionDialog>
  );
}

export default function CustomerPage() {
  const { id = "" } = useParams();
  const { session } = useSession();
  const owner = session?.me?.role === "owner";
  const { data: d, error, loading, reload } = useData<CustomerData>(`/api/app/customers/${id}`);
  useTitle(d?.customer.name ?? "Customer");
  if (error && !d) return <ErrorState error={error} retry={reload} />;
  if (loading && !d) return <Rows n={5} />;
  if (!d) return null;
  const c = d.customer;
  const callable = !c.dnc && c.consent && !c.consent.revoked_at;
  const owed = d.items.filter((i) => i.kind !== "class_cancel").reduce((s, i) => s + i.balance_cents, 0);
  return (
    <>
      <Link to="/customers" className="mb-3 inline-flex min-h-10 items-center gap-1.5 text-sm font-medium text-ink-2 hover:text-ink"><ArrowLeft className="size-4" />All customers</Link>
      <PageHead
        title={c.name}
        kicker={`${c.phone} · ${c.tz}`}
        happened={`${money(owed)} owed across ${d.items.length} item${d.items.length === 1 ? "" : "s"}.`}
        needs={callable ? undefined : c.dnc ? "They asked not to be called. Callback never will." : "No consent on file, so Callback won't call. Record it below if they agreed."}
        actions={owner ? <><NewCharge id={c.id} onDone={reload} />{c.link ? <Button variant="outline" asChild><Link to={c.link}><ExternalLink /> Their page</Link></Button> : null}</> : null}
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <div className="min-w-0">
          <Section id="items" title="Money">
            {d.items.length ? (
              <ul className="divide-y divide-line overflow-hidden rounded-[10px] border border-line bg-surface">
                {d.items.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <span className="lamp" data-s={moneyLamp(i.status)} aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{i.title}</div>
                      <div className="text-sm text-ink-2">{KIND[i.kind] ?? i.kind} · {word(i.status)}{i.due_local ? ` · due ${i.due_local}` : ""}{i.note ? ` · ${i.note}` : ""}</div>
                    </div>
                    <div className="text-right">
                      <div className="num font-medium">{money(i.kind === "class_cancel" ? i.owed_to_customer_cents : i.status === "paid" ? i.settled_cents : i.balance_cents)}</div>
                      <div className="text-xs text-ink-2">{i.kind === "class_cancel" ? "owed to them" : i.status === "paid" ? (i.captured ? "paid by PayPal" : "paid") : "owed"}</div>
                    </div>
                    {owner && i.can_cancel ? <CancelBooking item={i} onDone={reload} /> : null}
                  </li>
                ))}
              </ul>
            ) : <Empty title="Nothing owed">{owner ? "Add a deposit or an invoice with New charge." : null}</Empty>}
          </Section>
          <Section id="calls" title="Calls">
            {d.calls.length ? (
              <ul className="divide-y divide-line overflow-hidden rounded-[10px] border border-line bg-surface">
                {d.calls.map((x) => (
                  <li key={x.id}>
                    <Link to={`/calls/${x.id}`} className="flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-surface-2">
                      <span className="lamp" data-s={callLamp(x.status, x.outcome)} aria-hidden="true" />
                      <span className="flex-1"><span className="font-medium">{PURPOSE[x.purpose]}</span> <span className="text-sm text-ink-2">· {x.status === "ended" ? outcomeWord(x.outcome) : word(x.status)}{x.reason && x.status === "blocked" ? `: ${x.reason}` : ""}</span></span>
                      <span className="text-xs text-ink-2 num">{when(x.created_at)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <Empty title="No calls yet" />}
          </Section>
        </div>
        <aside className="space-y-4">
          <Panel className="p-4">
            <h3 className="flex items-center gap-2 font-semibold"><ShieldCheck className="size-4" />Consent</h3>
            {c.consent && !c.consent.revoked_at && !c.dnc ? (
              <>
                <StateChip s="done">Consent on file</StateChip>
                <p className="mt-2 text-sm">“{c.consent.text}”</p>
                <p className="text-xs text-ink-2">{c.consent.source} · {when(c.consent.granted_at)}</p>
                {owner ? <ActButton path={`/customers/${c.id}/consent`} fields={{ op: "revoke" }} variant="outline" size="sm" className="mt-3" confirmText={`Mark ${c.name} do-not-call? Callback will never call them again.`} onDone={reload}>Mark do-not-call</ActButton> : null}
              </>
            ) : (
              <>
                <StateChip s="off">{c.dnc ? "Do not call" : "No consent"}</StateChip>
                {owner ? (
                  <ActionDialog trigger={<Button variant="outline" size="sm" className="mt-3">Record consent</Button>} title="Record consent" description="The words the customer agreed to, and where. Only record consent they actually gave." path={`/customers/${c.id}/consent`} submit="Record consent" onDone={reload}>
                    <div className="grid gap-1.5"><Label htmlFor="text">What they agreed to</Label><Textarea id="text" name="text" rows={3} required /></div>
                    <Field id="source" label="Where" required placeholder="Signed booking form" />
                  </ActionDialog>
                ) : null}
              </>
            )}
          </Panel>
          {c.notes && owner ? <Panel className="p-4"><h3 className="font-semibold">Your notes</h3><p className="text-sm text-ink-2">{c.notes}</p></Panel> : null}
          <Panel className="p-4">
            <h3 className="mb-2 font-semibold">History</h3>
            {d.events.length ? <ul className="space-y-1.5 text-sm">{d.events.slice(0, 12).map((e, i) => <li key={i}><span className="text-xs text-ink-2 num">{when(e.at)}</span> {e.summary}</li>)}</ul> : <p className="text-sm text-ink-2">Nothing yet.</p>}
          </Panel>
        </aside>
      </div>
    </>
  );
}
