import { Fragment, useState } from "react";
import { Loader2, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Empty, ErrorState, Kpi, PageHead, Panel, Rows, Section, StateChip } from "@/components/app/bits";
import { act } from "@/lib/api";
import { money, PURPOSE, when } from "@/lib/format";
import { useData, useTitle } from "@/lib/hooks";

interface RulesT { purposes: string[]; hours: { start: string; end: string }; days: number[]; max_discount_pct: number; max_instalments: number; min_instalment_cents: number; max_attempts_per_day: number; cooldown_hours: number; auto_charge_max_cents: number; auto_refund_max_cents: number }
interface Backtest { cases: number; run: number; wait: number; deny: number; collected_auto_cents: number; held_cents: number; minutes_saved: number; minutes_still_by_hand: number; would_have_declined: number; breaches_prevented: number; rows: { id: string; purpose: string; customer: string; amount_cents: number; decision: string; why: string }[] }
interface Policy {
  active: { text: string; rules: RulesT };
  draft: { text: string; rules: RulesT; refused: string[]; unexpressed: string[]; source: string } | null;
  backtest: Backtest;
  history: { id: string; status: string; source: string; text: string; created_at: string }[];
}
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function RulesList({ r }: { r: RulesT }) {
  const items: [string, string][] = [
    ["Calls about", r.purposes.map((p) => PURPOSE[p] ?? p).join(", ")],
    ["Calling hours", `${r.hours.start} to ${r.hours.end}, their time`],
    ["Days", r.days.map((d) => DAYS[d]).join(" ")],
    ["Attempts", `${r.max_attempts_per_day} a day, ${r.cooldown_hours}h apart`],
    ["Discounts", r.max_discount_pct ? `up to ${r.max_discount_pct}%` : "none"],
    ["Plans", r.max_instalments > 1 ? `up to ${r.max_instalments} payments of at least ${money(r.min_instalment_cents)}` : "none"],
    ["Alone up to", `${money(r.auto_charge_max_cents)} charges, ${money(r.auto_refund_max_cents)} refunds`],
    ["Consent", "always required"],
  ];
  return (
    <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[9rem_1fr]">
      {items.map(([k, v]) => <Fragment key={k}><dt className="font-medium">{k}</dt><dd className="text-ink-2 num">{v}</dd></Fragment>)}
    </dl>
  );
}

export default function RulesPage() {
  useTitle("Rules");
  const [draft, setDraft] = useState<string | null>(null);
  const [text, setText] = useState("");
  const { data: p, error, loading, reload } = useData<Policy>(`/api/app/policy${draft ? `?draft=${encodeURIComponent(draft)}` : ""}`);
  const [busy, setBusy] = useState(false);
  if (error && !p) return <ErrorState error={error} retry={reload} />;
  if (loading && !p) return <Rows n={4} />;
  if (!p) return null;
  const bt = p.backtest;
  const save = async (op: "activate" | "draft") => {
    setBusy(true);
    try {
      toast.success((await act("/policy", { text: draft ?? text, op })).message);
      setDraft(null);
      setText("");
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHead
        title="Rules"
        happened="Your rules in plain English, compiled into checks the gate runs before every call and every money move."
        next={p.draft ? "Review the compiled draft and the replay, then adopt it or keep it as a draft." : "Write a change in your own words to see what it would do."}
      />
      <div className="grid gap-6 lg:grid-cols-2" data-tour="policy">
        <Section id="active" title="Active rules">
          <Panel className="p-4">
            <p className="mb-3 whitespace-pre-wrap rounded-[8px] bg-paper p-3 text-sm">{p.active.text}</p>
            <RulesList r={p.active.rules} />
          </Panel>
        </Section>
        <Section id="edit" title="Change them">
          <Panel className="p-4">
            <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) setDraft(text.trim()); }}>
              <Label htmlFor="policy-text">Say how you want calls handled</Label>
              <Textarea id="policy-text" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Only call between 10am and 6pm on weekdays. Never offer more than 10% off. Refunds over $80 need me." className="text-base md:text-sm" />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={!text.trim() || loading} aria-busy={loading && Boolean(draft)}>{loading && draft ? <Loader2 className="animate-spin" /> : <Wand2 />}Compile and replay</Button>
              </div>
            </form>
            {p.draft ? (
              <div className="mt-4 space-y-3 border-t border-line pt-4">
                <div className="flex items-center gap-2"><StateChip s={p.draft.refused.length ? "off" : "ready"}>{p.draft.refused.length ? "Can't adopt" : "Ready to adopt"}</StateChip><span className="text-xs text-ink-2">Compiled by {p.draft.source}</span></div>
                <RulesList r={p.draft.rules} />
                {p.draft.refused.length ? <div className="rounded-[8px] bg-off-soft p-3 text-sm"><b>Refused:</b> {p.draft.refused.join("; ")}</div> : null}
                {p.draft.unexpressed.length ? <div className="rounded-[8px] bg-ready-soft p-3 text-sm"><b>Couldn't express as a rule:</b> {p.draft.unexpressed.join("; ")}</div> : null}
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => save("activate")} disabled={busy || p.draft.refused.length > 0}>Adopt these rules</Button>
                  <Button variant="outline" onClick={() => save("draft")} disabled={busy}>Save as draft</Button>
                  <Button variant="ghost" onClick={() => setDraft(null)}>Discard</Button>
                </div>
              </div>
            ) : null}
          </Panel>
        </Section>
      </div>
      <Section id="replay" title={p.draft ? "Replay with the draft" : "Replay with your rules"} hint={`Your last ${bt.cases} calls, run again through ${p.draft ? "the draft" : "the active rules"} and your limits.`}>
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Would run alone" value={bt.run} s="done" />
          <Kpi label="Would wait for you" value={bt.wait} s="hold" />
          <Kpi label="Would not call" value={bt.deny} s="off" />
          <Kpi label="Collected without you" value={money(bt.collected_auto_cents)} hint={`${bt.minutes_saved} minutes of calls saved`} />
        </div>
        {bt.rows.length ? (
          <ul className="divide-y divide-line overflow-hidden rounded-[10px] border border-line bg-surface">
            {bt.rows.slice(0, 15).map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="lamp" data-s={r.decision === "run" ? "done" : r.decision === "wait" ? "hold" : "off"} aria-hidden="true" />
                <div className="min-w-0 flex-1"><div className="text-sm font-medium">{r.customer} · {PURPOSE[r.purpose] ?? r.purpose}</div><div className="truncate text-xs text-ink-2">{r.why}</div></div>
                <span className="num text-sm">{money(r.amount_cents)}</span>
              </li>
            ))}
          </ul>
        ) : <Empty title="No history to replay yet" />}
      </Section>
      {p.history.length ? (
        <Section id="history" title="Earlier versions">
          <ul className="space-y-2">{p.history.map((h) => <li key={h.id}><Panel className="p-3 text-sm"><div className="mb-1 flex items-center gap-2"><StateChip s={h.status === "active" ? "done" : "idle"}>{h.status}</StateChip><span className="text-xs text-ink-2 num">{when(h.created_at)} · {h.source}</span></div><p className="line-clamp-2 text-ink-2">{h.text}</p></Panel></li>)}</ul>
        </Section>
      ) : null}
    </>
  );
}
