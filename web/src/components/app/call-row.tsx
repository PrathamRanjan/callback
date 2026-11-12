import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { callLamp, money, outcomeWord, PURPOSE, LAMP_LABEL } from "@/lib/format";
import { Avatar } from "./bits";

import { t } from "@/i18n";
import { serverText } from "@/i18n/server-text";
export interface CallRow {
  id: string; status: string; purpose: string; outcome: string | null; reason: string | null; mode: string | null;
  customer: { id: string; name: string; tz: string } | null;
  item: { id: string; title: string; kind: string; balance_cents: number; owed_to_customer_cents: number; status: string } | null;
  scheduled_at: string | null; scheduled_local: string | null; ended_at: string | null; created_at: string; collected_cents: number; breaches: number; is_sample?: boolean;
}

/** Seeded, not a real call (spec 0.2 rule 4). Its money is never counted as confirmed by PayPal. */
export function SampleChip() {
  return <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[0.7rem] font-semibold uppercase tracking-wide text-ink-2" title={t("Seeded sample call, not a real one")}>{t("Sample")}</span>;
}

export function CallLine({ c }: { c: CallRow }) {
  const s = callLamp(c.status, c.outcome);
  const cents = c.item ? (c.item.kind === "class_cancel" ? c.item.owed_to_customer_cents : c.item.balance_cents) : null;
  const what = c.status === "ended" ? outcomeWord(c.outcome) || t("Ended") : c.status === "blocked" ? t("Not calling: {0}", [c.reason ? serverText(c.reason) : t("a rule says no")]) : c.status === "planned" ? c.scheduled_local ? t("Ready · {0} their time", [c.scheduled_local]) : t("Ready") : c.status === "skipped" ? (c.reason ? t("Skipped: {0}", [serverText(c.reason)]) : t("Skipped")) : LAMP_LABEL[s];
  return (
    <li>
      <Link to={`/calls/${c.id}`} className="flex min-h-[64px] items-center gap-3 px-4 py-3 hover:bg-surface-2 focus-visible:bg-surface-2">
        <Avatar name={c.customer?.name} s={s} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{c.customer?.name ?? t("Unknown")}</span>
            <span className="text-sm text-ink-2">{PURPOSE[c.purpose] ?? c.purpose}</span>
            {c.is_sample ? <SampleChip /> : null}
          </div>
          <div className={`line-clamp-2 text-sm ${s === "off" ? "text-off" : "text-ink-2"}`}><span className="sr-only">{LAMP_LABEL[s]}: </span>{what}</div>
        </div>
        <div className="text-right">
          <div className="num font-medium">{c.status === "ended" && c.collected_cents ? money(c.collected_cents) : money(cents)}</div>
          <div className="text-xs text-ink-2">{c.item?.kind === "class_cancel" ? t("owed to them") : c.status === "ended" && c.collected_cents ? t("collected") : t("owed")}</div>
        </div>
        <ChevronRight className="size-4 flex-none text-ink-2" aria-hidden="true" />
      </Link>
    </li>
  );
}

export function CallList({ rows, label, tour }: { rows: CallRow[]; label: string; tour?: string }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-[14px] border border-line bg-surface" aria-label={label} data-tour={tour}>
      {rows.map((c) => <CallLine key={c.id} c={c} />)}
    </ul>
  );
}
