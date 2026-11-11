import { Link } from "react-router-dom";
import { CalendarClock } from "lucide-react";
import { ActButton, Empty, ErrorState, Kpi, PageHead, Rows, Section } from "@/components/app/bits";
import { ApprovalCard, type Approval } from "@/components/app/approval";
import { CallList, type CallRow } from "@/components/app/call-row";
import { useData, useSession, useTitle } from "@/lib/hooks";
import { money, plural } from "@/lib/format";

interface Today {
  now: string; now_local: string; tz: string;
  kpis: { ready: number; blocked: number; collected_cents: number; finished_today: number; waiting: number; owed_cents: number };
  approvals: Approval[]; live: CallRow[]; ready: CallRow[]; blocked: CallRow[]; finished: CallRow[];
}

export default function TodayPage() {
  useTitle("Today");
  const { session, reload: reloadSession } = useSession();
  const { data, error, loading, reload } = useData<Today>("/api/app/today", { poll: 15000 });
  const owner = session?.me?.role === "owner";
  const refresh = async () => {
    await reload();
    await reloadSession();
  };
  if (error && !data) return <ErrorState error={error} retry={reload} />;
  if (loading && !data) return <Rows n={5} />;
  if (!data) return null;
  const k = data.kpis;
  return (
    <>
      <PageHead
        title="Today"
        kicker={`${session?.me?.business ?? ""} · ${data.now_local}`}
        happened={k.finished_today ? `${plural(k.finished_today, "call")} finished, ${money(k.collected_cents)} collected.` : "No calls finished yet today."}
        needs={owner ? (k.waiting ? `${plural(k.waiting, "money move")} waiting for your yes or no.` : "Nothing. Callback is inside your limits.") : undefined}
        next={k.ready ? `${plural(k.ready, "call")} ready to go.` : "No calls are ready. Re-plan after adding a charge."}
        actions={owner ? <ActButton path="/today/plan" variant="outline" icon={<CalendarClock />} onDone={refresh}>Re-plan calls</ActButton> : null}
      />
      <div className="kpi-grid mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4" data-tour="today-kpis">
        <Kpi label="Owed to you" value={money(k.owed_cents)} hint="Open deposits and invoices" />
        <Kpi label="Collected today" value={money(k.collected_cents)} s="done" hint={plural(k.finished_today, "finished call")} />
        <Kpi label="Ready to call" value={k.ready} s="ready" hint={`${k.blocked} not calling`} />
        <Kpi label="Needs you" value={k.waiting} s={k.waiting ? "hold" : "idle"} hint={owner ? "Held money moves" : "Owner only"} />
      </div>

      {owner ? (
        <Section id="needs" title="Needs you" hint="Held because they're over your limits. Nothing moves until you decide.">
          <div data-tour="today-needs" className="space-y-3">
            {data.approvals.length ? data.approvals.map((a) => <ApprovalCard key={a.id} a={a} passkey={false} compact onDone={refresh} />) : <Empty title="Nothing is waiting for you">When a call wants to move more than your limits, it stops here.</Empty>}
            {data.approvals.length ? <Link to="/approvals" className="inline-flex min-h-11 items-center text-sm font-medium text-brand underline-offset-4 hover:underline">See every approval and your limits</Link> : null}
          </div>
        </Section>
      ) : null}

      {data.live.length ? (
        <Section id="live" title="On the line now">
          <CallList rows={data.live} label="Calls happening now" />
        </Section>
      ) : null}

      <Section id="ready" title="Ready to call" hint="Each one passed consent, calling hours in their time zone and the once-a-day limit.">
        <div data-tour="today-ready" className="space-y-3">
          {data.ready.length ? <CallList rows={data.ready} label="Ready calls" /> : <Empty title="No calls are ready">Add a charge on a customer, or re-plan.</Empty>}
          {data.blocked.length ? (
            <>
              <h3 className="pt-2 text-sm font-semibold text-ink-2">Not calling, and why</h3>
              <CallList rows={data.blocked} label="Blocked calls" />
            </>
          ) : null}
        </div>
      </Section>

      <Section id="finished" title="Finished">
        {data.finished.length ? <CallList rows={data.finished} label="Finished calls" /> : <Empty title="No finished calls yet">Open a ready call and start it in the simulator.</Empty>}
      </Section>
    </>
  );
}
