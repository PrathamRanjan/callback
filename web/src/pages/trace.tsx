import { useParams } from "react-router-dom";
import { ErrorState, PageHead, Panel, Rows, StateChip } from "@/components/app/bits";
import { toolWord } from "@/components/app/call-score";
import { when } from "@/lib/format";
import { useData, useTitle } from "@/lib/hooks";

import { t } from "@/i18n";
interface TraceData { run: { id: string; actor: string; agent_id: string | null; subject: string; status: string; started_at: string; ended_at: string | null }; steps: { step: number; actor: string; tool: string; args: unknown; policy: string | null; gate: string | null; result: unknown; pp_request_id: string | null; pp_debug_id: string | null; duration_ms: number | null; at: string }[] }
const GATE: Record<string, "done" | "hold" | "off" | "idle"> = { allowed: "done", held: "hold", denied: "off", dry_run_refused: "off" };

export default function TracePage() {
  const { id = "" } = useParams();
  const { data: tr, error, loading, reload } = useData<TraceData>(`/api/app/trace/${id}`);
  useTitle(tr ? t("Trace: {0}", [tr.run.subject]) : t("Trace"));
  if (error && !tr) return <ErrorState error={error} retry={reload} />;
  if (loading && !tr) return <Rows n={6} />;
  if (!tr) return null;
  return (
    <>
      <PageHead title={tr.run.subject || t("Agent run")} kicker={<span className="font-mono">{tr.run.id}</span>} happened={t("{0} steps by {1}{2}, started {3}.", [tr.steps.length, tr.run.actor, tr.run.agent_id ? ` (${tr.run.agent_id})` : "", when(tr.run.started_at)])} next={<StateChip s={tr.run.status === "done" ? "done" : tr.run.status === "error" ? "off" : "live"}>{tr.run.status}</StateChip>} />
      <ol className="space-y-2">
        {tr.steps.map((s) => (
          <li key={s.step}>
            <Panel className="p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-8 font-mono text-xs text-ink-2 num">#{s.step}</span>
                <span className="font-medium">{toolWord(s.tool)}</span>
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs">{s.actor}</span>
                {s.gate && s.gate !== "n/a" ? <StateChip s={GATE[s.gate] ?? "idle"}>{s.gate.replace(/_/g, " ")}</StateChip> : null}
                <span className="ml-auto text-xs text-ink-2 num">{s.duration_ms != null ? t("{0} ms · ", [s.duration_ms]) : ""}{when(s.at)}</span>
              </div>
              {s.policy ? <p className="mt-1 text-sm text-ink-2">{s.policy}</p> : null}
              {s.pp_request_id || s.pp_debug_id ? <p className="mt-1 break-all font-mono text-xs text-ink-2">{s.pp_request_id ? t("PayPal-Request-Id {0}", [s.pp_request_id]) : ""}{s.pp_debug_id ? t(" · debug {0}", [s.pp_debug_id]) : ""}</p> : null}
              {s.args || s.result ? (
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer py-1 font-medium text-ink-2">{t("Arguments and result")}</summary>
                  <pre className="mt-1 max-h-[300px] overflow-auto rounded-[10px] bg-paper p-2 font-mono text-[0.72rem] leading-relaxed">{JSON.stringify({ args: s.args, result: s.result }, null, 2)}</pre>
                </details>
              ) : null}
            </Panel>
          </li>
        ))}
      </ol>
    </>
  );
}
