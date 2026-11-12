import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Ban, CirclePlus, ExternalLink, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ActButton, Empty, ErrorState, PageHead, Panel, Rows, Section, StateChip } from "@/components/app/bits";
import { ActionDialog, Field, NativeSelect } from "@/components/app/form";
import { useData, useSession, useTitle } from "@/lib/hooks";
import { callLamp, money, moneyLamp, outcomeWord, PURPOSE, when, word, plural } from "@/lib/format";

import { t, tmap } from "@/i18n";
import { serverText } from "@/i18n/server-text";
import { LANGS } from "@/i18n";
import { postJson } from "@/lib/api";
import { toast } from "sonner";

/** Which language Callback calls and texts this customer in (spec item 5.1). The customer can change it on their own page. */
function CustomerLang({ id, lang, onDone }: { id: string; lang: string; onDone: () => void }) {
  const [v, setV] = useState(lang);
  return (
    <Panel className="p-4">
      <NativeSelect id="cust-lang" label={t("Calls and texts in")} value={v} onChange={async (e) => {
        const next = e.target.value;
        setV(next);
        try {
          await postJson(`/api/app/customers/${id}/lang`, { lang: next });
          toast.success(t("Saved. The next call and text use {0}.", [LANGS.find((l) => l.code === next)?.name ?? next]));
          onDone();
        } catch (x) {
          setV(lang);
          toast.error((x as Error).message);
        }
      }}>
        {LANGS.map((l) => <option key={l.code} value={l.code} lang={l.code}>{l.name}</option>)}
      </NativeSelect>
      <p className="mt-2 text-xs text-ink-2">{t("If they answer in another of these languages, the voice agent switches to it.")}</p>
    </Panel>
  );
}
interface Item { id: string; kind: string; title: string; note: string; amount_cents: number; discount_cents: number; settled_cents: number; balance_cents: number; owed_to_customer_cents: number; status: string; due_local: string | null; appointment_local: string | null; captured: boolean; can_cancel: boolean }
interface CustomerData {
  customer: { id: string; name: string; phone: string; email: string | null; tz: string; lang?: string; notes: string; dnc: boolean; consent: { granted_at: string; source: string; text: string; revoked_at: string | null } | null; link: string | null };
  items: Item[];
  calls: { id: string; status: string; purpose: string; outcome: string | null; reason: string | null; created_at: string }[];
  events: { at: string; type: string; summary: string; actor: string }[];
}
const KIND: Record<string, string> = tmap({ deposit: "Deposit", invoice: "Invoice", class_cancel: "Cancelled booking" });
const iso = (v: string) => (v ? new Date(v).toISOString() : "");

function NewCharge({ id, onDone }: { id: string; onDone: () => void }) {
  const [kind, setKind] = useState("deposit");
  return (
    <ActionDialog
      trigger={<Button><CirclePlus />{" "}{t("New charge")}</Button>}
      title={t("New charge")}
      description={t("Callback re-plans its calls straight after. Times are in your device's time zone.")}
      path={`/customers/${id}/charges`}
      submit="Add charge"
      onDone={onDone}
      transform={(f) => ({ ...f, due_at: iso(f.due_at), appointment_at: iso(f.appointment_at ?? "") })}
    >
      <NativeSelect id="kind" label={t("What is it?")} value={kind} onChange={(e) => setKind(e.target.value)}>
        <option value="deposit">{t("Deposit before a booking")}</option>
        <option value="invoice">{t("Invoice")}</option>
      </NativeSelect>
      <Field id="title" label={t("Description")} required placeholder={kind === "deposit" ? t("Thursday 7am reformer class") : t("Five-class pack")} />
      <Field id="amount" label={t("Amount in dollars")} required inputMode="decimal" placeholder="60.00" hint={t("Up to $10,000.00.")} />
      <Field id="due_at" label={kind === "deposit" ? t("Deposit due") : t("Invoice due")} type="datetime-local" required />
      {kind === "deposit" ? <Field id="appointment_at" label={t("Booking starts")} type="datetime-local" required /> : null}
      <div className="grid gap-1.5">
        <Label htmlFor="note">{t("Note (optional)")}</Label>
        <Textarea id="note" name="note" rows={2} />
      </div>
    </ActionDialog>
  );
}

function CancelBooking({ item, onDone }: { item: Item; onDone: () => void }) {
  return (
    <ActionDialog
      trigger={<Button variant="outline" size="sm" data-tour="cancel-booking"><Ban />{" "}{t("Cancel booking")}</Button>}
      title={t("Cancel {0}?", [item.title])}
      description={t("Callback will call to offer a {0} refund{1} or a class credit. Refunds wait for your approval if they're over your limit.", [money(item.settled_cents), item.captured ? " back to their PayPal" : " (paid outside PayPal, so you pay it back by hand)"])}
      path={`/obligations/${item.id}/cancel`}
      submit="Cancel the booking"
      onDone={onDone}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="reason">{t("Reason Callback will give")}</Label>
        <Textarea id="reason" name="reason" rows={2} required placeholder={t("The instructor is unwell")} />
      </div>
    </ActionDialog>
  );
}

export default function CustomerPage() {
  const { id = "" } = useParams();
  const { session } = useSession();
  const owner = session?.me?.role === "owner";
  const { data: d, error, loading, reload } = useData<CustomerData>(`/api/app/customers/${id}`);
  useTitle(d?.customer.name ?? t("Customer"));
  if (error && !d) return <ErrorState error={error} retry={reload} />;
  if (loading && !d) return <Rows n={5} />;
  if (!d) return null;
  const c = d.customer;
  const callable = !c.dnc && c.consent && !c.consent.revoked_at;
  const owed = d.items.filter((i) => i.kind !== "class_cancel").reduce((s, i) => s + i.balance_cents, 0);
  return (
    <>
      <Link to="/customers" className="mb-3 inline-flex min-h-10 items-center gap-1.5 text-sm font-medium text-ink-2 hover:text-ink"><ArrowLeft className="size-4" />{t("All customers")}</Link>
      <PageHead
        title={c.name}
        kicker={`${c.phone} · ${c.tz}`}
        happened={t("{amount} owed across {items}.", { amount: money(owed), items: plural(d.items.length, "item") })}
        needs={callable ? undefined : c.dnc ? t("They asked not to be called. Callback never will.") : t("No consent on file, so Callback won't call. Record it below if they agreed.")}
        actions={owner ? <><NewCharge id={c.id} onDone={reload} />{c.link ? <Button variant="outline" asChild><Link to={c.link}><ExternalLink />{" "}{t("Their page")}</Link></Button> : null}</> : null}
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_340px] [&>*]:min-w-0">
        <div className="min-w-0">
          <Section id="items" title={t("Money")}>
            {d.items.length ? (
              <ul className="divide-y divide-line overflow-hidden rounded-[14px] border border-line bg-surface">
                {d.items.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <span className="lamp" data-s={moneyLamp(i.status)} aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{i.title}</div>
                      <div className="text-sm text-ink-2">{KIND[i.kind] ?? i.kind} · {word(i.status)}{i.due_local ? t(" · due {0}", [i.due_local]) : ""}{i.note ? ` · ${i.note}` : ""}</div>
                    </div>
                    <div className="text-right">
                      <div className="num font-medium">{money(i.kind === "class_cancel" ? i.owed_to_customer_cents : i.status === "paid" ? i.settled_cents : i.balance_cents)}</div>
                      <div className="text-xs text-ink-2">{i.kind === "class_cancel" ? t("owed to them") : i.status === "paid" ? (i.captured ? t("paid by PayPal") : t("paid")) : t("owed")}</div>
                    </div>
                    {owner && i.can_cancel ? <CancelBooking item={i} onDone={reload} /> : null}
                  </li>
                ))}
              </ul>
            ) : <Empty title={t("Nothing owed")}>{owner ? t("Add a deposit or an invoice with New charge.") : null}</Empty>}
          </Section>
          <Section id="calls" title={t("Calls")}>
            {d.calls.length ? (
              <ul className="divide-y divide-line overflow-hidden rounded-[14px] border border-line bg-surface">
                {d.calls.map((x) => (
                  <li key={x.id}>
                    <Link to={`/calls/${x.id}`} className="flex min-h-14 items-center gap-3 px-4 py-3 hover:bg-surface-2">
                      <span className="lamp" data-s={callLamp(x.status, x.outcome)} aria-hidden="true" />
                      <span className="flex-1"><span className="font-medium">{PURPOSE[x.purpose]}</span> <span className="text-sm text-ink-2">· {x.status === "ended" ? outcomeWord(x.outcome) : word(x.status)}{x.reason && x.status === "blocked" ? `: ${serverText(x.reason)}` : ""}</span></span>
                      <span className="text-xs text-ink-2 num">{when(x.created_at)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <Empty title={t("No calls yet")} />}
          </Section>
        </div>
        <aside className="space-y-4">
          <CustomerLang id={c.id} lang={c.lang ?? "en"} onDone={reload} />
          <Panel className="p-4">
            <h3 className="flex items-center gap-2 font-semibold"><ShieldCheck className="size-4" />{t("Consent")}</h3>
            {c.consent && !c.consent.revoked_at && !c.dnc ? (
              <>
                <StateChip s="done">{t("Consent on file")}</StateChip>
                <p className="mt-2 text-sm">“{c.consent.text}”</p>
                <p className="text-xs text-ink-2">{c.consent.source} · {when(c.consent.granted_at)}</p>
                {owner ? <ActButton path={`/customers/${c.id}/consent`} fields={{ op: "revoke" }} variant="outline" size="sm" className="mt-3" confirmText={t("Mark {0} do-not-call? Callback will never call them again.", [c.name])} onDone={reload}>{t("Mark do-not-call")}</ActButton> : null}
              </>
            ) : (
              <>
                <StateChip s="off">{c.dnc ? t("Do not call") : t("No consent")}</StateChip>
                {owner ? (
                  <ActionDialog trigger={<Button variant="outline" size="sm" className="mt-3">{t("Record consent")}</Button>} title={t("Record consent")} description={t("The words the customer agreed to, and where. Only record consent they actually gave.")} path={`/customers/${c.id}/consent`} submit="Record consent" onDone={reload}>
                    <div className="grid gap-1.5"><Label htmlFor="text">{t("What they agreed to")}</Label><Textarea id="text" name="text" rows={3} required /></div>
                    <Field id="source" label={t("Where")} required placeholder={t("Signed booking form")} />
                  </ActionDialog>
                ) : null}
              </>
            )}
          </Panel>
          {c.notes && owner ? <Panel className="p-4"><h3 className="font-semibold">{t("Your notes")}</h3><p className="text-sm text-ink-2">{c.notes}</p></Panel> : null}
          <Panel className="p-4">
            <h3 className="mb-2 font-semibold">{t("History")}</h3>
            {d.events.length ? <ul className="space-y-1.5 text-sm">{d.events.slice(0, 12).map((e, i) => <li key={i}><span className="text-xs text-ink-2 num">{when(e.at)}</span> {e.summary}</li>)}</ul> : <p className="text-sm text-ink-2">{t("Nothing yet.")}</p>}
          </Panel>
        </aside>
      </div>
    </>
  );
}
