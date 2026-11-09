import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { callLamp, money, outcomeWord, PURPOSE, LAMP_LABEL } from "@/lib/format";
import { Avatar } from "./bits";

export interface CallRow {
  id: string; status: string; purpose: string; outcome: string | null; reason: string | null; mode: string | null;
  customer: { id: string; name: string; tz: string } | null;
  item: { id: string; title: string; kind: string; balance_cents: number; owed_to_customer_cents: number; status: string } | null;
  scheduled_at: string | null; scheduled_local: string | null; ended_at: string | null; created_at: string; collected_cents: number; breaches: number;
}

export function CallLine({ c }: { c: CallRow }) {
  const s = callLamp(c.status, c.outcome);
  const cents = c.item ? (c.item.kind === "class_cancel" ? c.item.owed_to_customer_cents : c.item.balance_cents) : null;
  const what = c.status === "ended" ? outcomeWord(c.outcome) || "Ended" : c.status === "blocked" ? `Not calling: ${c.reason ?? "a rule says no"}` : c.status === "planned" ? c.scheduled_local ? `Ready · ${c.scheduled_local} their time` : "Ready" : c.status === "skipped" ? `Skipped${c.reason ? `: ${c.reason}` : ""}` : LAMP_LABEL[s];
  return (
    <li>
      <Link to={`/calls/${c.id}`} className="flex min-h-[64px] items-center gap-3 px-4 py-3 hover:bg-surface-2 focus-visible:bg-surface-2">
        <Avatar name={c.customer?.name} s={s} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{c.customer?.name ?? "Unknown"}</span>
            <span className="text-sm text-ink-2">{PURPOSE[c.purpose] ?? c.purpose}</span>
          </div>
          <div className={`truncate text-sm ${s === "off" ? "text-off" : "text-ink-2"}`}><span className="sr-only">{LAMP_LABEL[s]}: </span>{what}</div>
        </div>
        <div className="text-right">
          <div className="num font-medium">{c.status === "ended" && c.collected_cents ? money(c.collected_cents) : money(cents)}</div>
          <div className="text-xs text-ink-2">{c.item?.kind === "class_cancel" ? "owed to them" : c.status === "ended" && c.collected_cents ? "collected" : "owed"}</div>
        </div>
        <ChevronRight className="size-4 flex-none text-ink-2" aria-hidden="true" />
      </Link>
    </li>
  );
}

export function CallList({ rows, label, tour }: { rows: CallRow[]; label: string; tour?: string }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-[10px] border border-line bg-surface" aria-label={label} data-tour={tour}>
      {rows.map((c) => <CallLine key={c.id} c={c} />)}
    </ul>
  );
}
