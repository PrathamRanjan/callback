import { Fragment, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Loader2, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Empty, ErrorState, Kpi, PageHead, Panel, Rows, Section, StateChip } from "@/components/app/bits";
import { act } from "@/lib/api";
import { money, PURPOSE, when } from "@/lib/format";
import { useData, useTitle } from "@/lib/hooks";

import { locale, t } from "@/i18n";
interface RulesT { purposes: string[]; hours: { start: string; end: string }; days: number[]; max_discount_pct: number; max_instalments: number; min_instalment_cents: number; max_attempts_per_day: number; cooldown_hours: number; auto_charge_max_cents: number; auto_refund_max_cents: number }
interface Backtest { cases: number; run: number; wait: number; deny: number; collected_auto_cents: number; held_cents: number; minutes_saved: number; minutes_still_by_hand: number; would_have_declined: number; breaches_prevented: number; rows: { id: string; purpose: string; customer: string; amount_cents: number; decision: string; why: string }[] }
interface Policy {
  active: { text: string; rules: RulesT };
  draft: { text: string; rules: RulesT; refused: string[]; unexpressed: string[]; source: string; ai_failed?: boolean } | null;
  backtest: Backtest;
  history: { id: string; status: string; source: string; text: string; created_at: string }[];
}
/** Weekday names in the chosen language (1 Jan 2023 was a Sunday). */
const day = (d: number) => new Intl.DateTimeFormat(locale(), { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2023, 0, 1 + d)));

function RulesList({ r }: { r: RulesT }) {
  const items: [string, string][] = [
    [t("Calls about"), r.purposes.map((p) => PURPOSE[p] ?? p).join(", ")],
    [t("Calling hours"), t("{start} to {end}, their time", r.hours)],
    [t("Days"), r.days.map((d) => day(d)).join(" ")],
    [t("Attempts"), t("{n} a day, {h}h apart", { n: r.max_attempts_per_day, h: r.cooldown_hours })],
    [t("Discounts"), r.max_discount_pct ? t("up to {0}%", [r.max_discount_pct]) : t("none")],
    [t("Plans"), r.max_instalments > 1 ? t("up to {n} payments of at least {amount}", { n: r.max_instalments, amount: money(r.min_instalment_cents) }) : t("none")],
    [t("Alone up to"), t("{charge} charges, {refund} refunds", { charge: money(r.auto_charge_max_cents), refund: money(r.auto_refund_max_cents) })],
    [t("Consent"), t("always required")],
  ];
  return (
    <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[9rem_1fr]">
      {items.map(([k, v]) => <Fragment key={k}><dt className="font-medium">{k}</dt><dd className="text-ink-2 num">{v}</dd></Fragment>)}
    </dl>
  );
}

export default function RulesPage() {
  useTitle(t("Rules"));
  // A proposal from Ask opens here as a draft: the owner reads the compiled rules and the backtest before anything changes.
  const [sp] = useSearchParams();
  const [draft, setDraft] = useState<string | null>(sp.get("draft"));
  const [text, setText] = useState(sp.get("draft") ?? "");
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
        title={t("Rules")}
        happened={t("Your rules in plain English, compiled into checks the gate runs before every call and every money move.")}
        next={p.draft ? t("Review the compiled draft and the replay, then adopt it or keep it as a draft.") : t("Write a change in your own words to see what it would do.")}
      />
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0" data-tour="policy">
        <Section id="active" title={t("Active rules")}>
          <Panel className="p-4">
            <p className="mb-3 whitespace-pre-wrap rounded-[8px] bg-paper p-3 text-sm">{p.active.text}</p>
            <RulesList r={p.active.rules} />
          </Panel>
        </Section>
        <Section id="edit" title={t("Change them")}>
          <Panel className="p-4">
            <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) setDraft(text.trim()); }}>
              <Label htmlFor="policy-text">{t("Say how you want calls handled")}</Label>
              <Textarea id="policy-text" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("Only call between 10am and 6pm on weekdays. Never offer more than 10% off. Refunds over $80 need me.")} className="text-base md:text-sm" />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={!text.trim() || loading} aria-busy={loading && Boolean(draft)}>{loading && draft ? <Loader2 className="animate-spin" /> : <Wand2 />}{t("Compile and replay")}</Button>
              </div>
            </form>
            {p.draft ? (
              <div className="mt-4 space-y-3 border-t border-line pt-4">
                {p.draft.ai_failed ? (
                  <div role="alert" className="rounded-[8px] bg-off-soft p-3 text-sm">
                    <b>{t("I couldn't read that with the AI model.")}</b>{" "}{t("Nothing was changed. The numbers below were read by code only, so these rules can't be adopted yet.")}
                    <div className="mt-2"><Button size="sm" variant="outline" onClick={() => reload()} disabled={loading}>{loading ? <Loader2 className="animate-spin" /> : null}{t("Try again")}</Button></div>
                  </div>
                ) : null}
                <div className="flex items-center gap-2"><StateChip s={p.draft.refused.length || p.draft.ai_failed ? "off" : "ready"}>{p.draft.refused.length || p.draft.ai_failed ? t("Can't adopt") : t("Ready to adopt")}</StateChip><span className="text-xs text-ink-2">{p.draft.ai_failed ? t("Numbers read by code only") : p.draft.source === "model" ? t("Read by the AI model; numbers by code") : t("Read by the rules arm (test only)")}</span></div>
                <RulesList r={p.draft.rules} />
                {p.draft.refused.length ? <div className="rounded-[8px] bg-off-soft p-3 text-sm"><b>{t("Refused:")}</b> {p.draft.refused.join("; ")}</div> : null}
                {p.draft.unexpressed.length ? <div className="rounded-[8px] bg-ready-soft p-3 text-sm"><b>{t("Couldn't express as a rule:")}</b> {p.draft.unexpressed.join("; ")}</div> : null}
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => save("activate")} disabled={busy || p.draft.refused.length > 0 || p.draft.ai_failed}>{t("Adopt these rules")}</Button>
                  <Button variant="outline" onClick={() => save("draft")} disabled={busy || p.draft.ai_failed}>{t("Save as draft")}</Button>
                  <Button variant="ghost" onClick={() => setDraft(null)}>{t("Discard")}</Button>
                </div>
              </div>
            ) : null}
          </Panel>
        </Section>
      </div>
      <Section id="replay" title={p.draft ? t("Replay with the draft") : t("Replay with your rules")} hint={t("Your last {0} calls, run again through {1} and your limits.", [bt.cases, p.draft ? "the draft" : "the active rules"])}>
        <div className="kpi-grid mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label={t("Would run alone")} value={bt.run} s="done" />
          <Kpi label={t("Would wait for you")} value={bt.wait} s="hold" />
          <Kpi label={t("Would not call")} value={bt.deny} s="off" />
          <Kpi label={t("Collected without you")} value={money(bt.collected_auto_cents)} hint={t("{0} minutes of calls saved", [bt.minutes_saved])} />
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
        ) : <Empty title={t("No history to replay yet")} />}
      </Section>
      {p.history.length ? (
        <Section id="history" title={t("Earlier versions")}>
          <ul className="space-y-2">{p.history.map((h) => <li key={h.id}><Panel className="p-3 text-sm"><div className="mb-1 flex items-center gap-2"><StateChip s={h.status === "active" ? "done" : "idle"}>{h.status}</StateChip><span className="text-xs text-ink-2 num">{when(h.created_at)} · {h.source}</span></div><p className="line-clamp-2 text-ink-2">{h.text}</p></Panel></li>)}</ul>
        </Section>
      ) : null}
    </>
  );
}
