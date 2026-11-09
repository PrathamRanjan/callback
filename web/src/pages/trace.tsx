import { useParams } from "react-router-dom";
import { ErrorState, PageHead, Panel, Rows, StateChip } from "@/components/app/bits";
import { toolWord } from "@/components/app/call-score";
import { when } from "@/lib/format";
import { useData, useTitle } from "@/lib/hooks";

interface TraceData { run: { id: string; actor: string; agent_id: string | null; subject: string; status: string; started_at: string; ended_at: string | null }; steps: { step: number; actor: string; tool: string; args: unknown; policy: string | null; gate: string | null; result: unknown; pp_request_id: string | null; pp_debug_id: string | null; duration_ms: number | null; at: string }[] }
const GATE: Record<string, "done" | "hold" | "off" | "idle"> = { allowed: "done", held: "hold", denied: "off", dry_run_refused: "off" };

export default function TracePage() {
  const { id = "" } = useParams();
  const { data: t, error, loading, reload } = useData<TraceData>(`/api/app/trace/${id}`);
  useTitle(t ? `Trace: ${t.run.subject}` : "Trace");
  if (error && !t) return <ErrorState error={error} retry={reload} />;
  if (loading && !t) return <Rows n={6} />;
  if (!t) return null;
  return (
    <>
      <PageHead title={t.run.subject || "Agent run"} kicker={<span className="font-mono">{t.run.id}</span>} happened={`${t.steps.length} steps by ${t.run.actor}${t.run.agent_id ? ` (${t.run.agent_id})` : ""}, started ${when(t.run.started_at)}.`} next={<StateChip s={t.run.status === "done" ? "done" : t.run.status === "error" ? "off" : "live"}>{t.run.status}</StateChip>} />
      <ol className="space-y-2">
        {t.steps.map((s) => (
          <li key={s.step}>
            <Panel className="p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-8 font-mono text-xs text-ink-2 num">#{s.step}</span>
                <span className="font-medium">{toolWord(s.tool)}</span>
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs">{s.actor}</span>
                {s.gate && s.gate !== "n/a" ? <StateChip s={GATE[s.gate] ?? "idle"}>{s.gate.replace(/_/g, " ")}</StateChip> : null}
                <span className="ml-auto text-xs text-ink-2 num">{s.duration_ms != null ? `${s.duration_ms} ms · ` : ""}{when(s.at)}</span>
              </div>
              {s.policy ? <p className="mt-1 text-sm text-ink-2">{s.policy}</p> : null}
              {s.pp_request_id || s.pp_debug_id ? <p className="mt-1 break-all font-mono text-xs text-ink-2">{s.pp_request_id ? `PayPal-Request-Id ${s.pp_request_id}` : ""}{s.pp_debug_id ? ` · debug ${s.pp_debug_id}` : ""}</p> : null}
              {s.args || s.result ? (
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer py-1 font-medium text-ink-2">Arguments and result</summary>
                  <pre className="mt-1 max-h-[300px] overflow-auto rounded-[8px] bg-paper p-2 font-mono text-[0.72rem] leading-relaxed">{JSON.stringify({ args: s.args, result: s.result }, null, 2)}</pre>
                </details>
              ) : null}
            </Panel>
          </li>
        ))}
      </ol>
    </>
  );
}
