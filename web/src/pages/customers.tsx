import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, Empty, ErrorState, PageHead, Rows } from "@/components/app/bits";
import { ActionDialog, Field, NativeSelect } from "@/components/app/form";
import { useData, useSession, useTitle } from "@/lib/hooks";
import { money, plural } from "@/lib/format";

import { t } from "@/i18n";
export interface CustomerRow { id: string; name: string; phone: string; email: string | null; tz: string; dnc: boolean; consent: { granted_at: string; source: string; revoked_at: string | null } | null; owed_cents: number; owed_to_them_cents: number; open_items: number }

export const TZS = ["Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane", "Australia/Perth", "Pacific/Auckland", "Asia/Singapore", "Europe/London", "America/New_York", "America/Los_Angeles"];

export function NewCustomer({ onDone }: { onDone?: () => void }) {
  return (
    <ActionDialog
      trigger={<Button><UserPlus />{" "}{t("New customer")}</Button>}
      title={t("New customer")}
      description={t("Callback only calls people with consent on file. Leave consent empty and they're never called.")}
      path="/customers"
      submit="Add customer"
      onDone={onDone}
      follow
    >
      <Field id="name" label={t("Name")} required autoComplete="off" />
      <Field id="phone" label={t("Mobile")} required inputMode="tel" placeholder="+61 491 570 006" hint={t("International format, starting with +.")} />
      <Field id="email" label={t("Email (optional)")} type="email" />
      <NativeSelect id="tz" label={t("Their time zone")} defaultValue="Australia/Sydney">{TZS.map((z) => <option key={z}>{z}</option>)}</NativeSelect>
      <div className="grid gap-1.5">
        <Label htmlFor="consent_text">{t("Consent to be called (optional)")}</Label>
        <Textarea id="consent_text" name="consent_text" rows={2} placeholder={t("Agreed to reminder calls about bookings and payments when booking online.")} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="consent_source">{t("Where they gave it")}</Label>
        <Input id="consent_source" name="consent_source" placeholder={t("Booking form, 3 Mar")} className="h-11" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="notes">{t("Notes (only you see these)")}</Label>
        <Textarea id="notes" name="notes" rows={2} />
      </div>
    </ActionDialog>
  );
}

export default function CustomersPage() {
  useTitle(t("Customers"));
  const { session } = useSession();
  const owner = session?.me?.role === "owner";
  const { data, error, loading, reload } = useData<CustomerRow[]>("/api/app/customers");
  const [q, setQ] = useState("");
  const rows = useMemo(() => (data ?? []).filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase())), [data, q]);
  const owed = (data ?? []).reduce((s, c) => s + c.owed_cents, 0);
  return (
    <>
      <PageHead
        title={t("Customers")}
        happened={data ? t("{0}, {1} owed in total.", [plural(data.length, "customer"), money(owed)]) : undefined}
        needs={data && data.some((c) => !c.consent || c.consent.revoked_at) ? t("{0} without consent are never called.", [plural(data.filter((c) => !c.consent || c.consent.revoked_at).length, "customer")]) : undefined}
        actions={owner ? <NewCustomer onDone={reload} /> : null}
      />
      <Input type="search" placeholder={t("Find a customer")} aria-label={t("Find a customer")} value={q} onChange={(e) => setQ(e.target.value)} className="mb-4 h-11 md:max-w-[320px]" />
      {error && !data ? <ErrorState error={error} retry={reload} /> : loading && !data ? <Rows n={6} /> : rows.length ? (
        <ul className="divide-y divide-line overflow-hidden rounded-[10px] border border-line bg-surface">
          {rows.map((c) => {
            const s = c.dnc || !c.consent || c.consent.revoked_at ? "off" : c.owed_cents ? "ready" : c.owed_to_them_cents ? "hold" : "done";
            return (
              <li key={c.id}>
                <Link to={`/customers/${c.id}`} className="flex min-h-[64px] items-center gap-3 px-4 py-3 hover:bg-surface-2">
                  <Avatar name={c.name} s={s} />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{c.name}</div>
                    <div className="truncate text-sm text-ink-2">{c.dnc ? t("Asked not to be called") : !c.consent || c.consent.revoked_at ? t("No consent: never called") : `${plural(c.open_items, "open item")} · ${c.tz.split("/").pop()?.replace(/_/g, " ")}`}</div>
                  </div>
                  <div className="text-right">
                    <div className="num font-medium">{money(c.owed_to_them_cents && !c.owed_cents ? c.owed_to_them_cents : c.owed_cents)}</div>
                    <div className="text-xs text-ink-2">{c.owed_to_them_cents && !c.owed_cents ? t("owed to them") : t("owed")}</div>
                  </div>
                  <ChevronRight className="size-4 text-ink-2" aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ul>
      ) : <Empty title={q ? t("Nobody by that name") : t("No customers yet")}>{owner && !q ? t("Add your first customer to start.") : null}</Empty>}
    </>
  );
}
