import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Bot, Database, Lightbulb, Loader2, Mic, MicOff, Send, Wallet, X } from "lucide-react";
import { useDictation } from "@/lib/voice";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Empty, ErrorState, PageHead, Panel, Rows, Section, StateChip } from "@/components/app/bits";
import { postJson } from "@/lib/api";
import { when, plural } from "@/lib/format";
import { useData, useTitle } from "@/lib/hooks";

import { t, tk } from "@/i18n";
interface Step { step: number; actor: string; tool: string; args: any; result: any; duration_ms: number | null; at: string }
interface AskHome {
  presets: string[];
  runs: { id: string; status: string; subject: string; started_at: string }[];
  proposals: { id: string; kind: string; payload: any; reason: string; status: string; run_id: string; created_at: string }[];
  brain: "model" | "rules" | "none";
  brain_label: string;
}
const SOURCE: Record<string, { label: string; icon: typeof Database }> = {
  callback: { label: tk("Callback MCP"), icon: Database },
  paypal: { label: tk("PayPal MCP"), icon: Wallet },
  propose: { label: tk("Proposal"), icon: Lightbulb },
};

/** One row per tool call: name, a one-line summary of its arguments, how long it took, and a one-line result. */
function Rail({ steps, live, highlight }: { steps: Step[]; live: boolean; highlight: string | null }) {
  const tools = steps.filter((s) => s.tool === "ask.tool");
  const models = steps.filter((s) => s.tool === "ask.model");
  const notes = steps.filter((s) => s.tool === "ask.note");
  return (
    <div className="space-y-2" aria-live="polite">
      <p className="text-xs text-ink-2">{plural(tools.length, "tool call")} · {plural(models.length, "model step")}{models.length ? ` · ${models.at(-1)?.result?.model}` : ""}</p>
      {notes.map((n) => <p key={n.step} className="rounded-[8px] bg-hold-soft px-3 py-2 text-xs">{n.result?.note}</p>)}
      <ol className="space-y-2">
        {steps.filter((s) => s.tool === "ask.tool" || s.tool === "ask.model").map((s) => {
          if (s.tool === "ask.model") return <li key={s.step} className="flex items-center gap-2 px-1 text-xs text-ink-2"><Bot className="size-3.5" aria-hidden="true" />{t("Model step")}{" "}{s.result?.step}: {s.result?.calls ? t("asked for {0} tool{1}", [s.result.calls, s.result.calls === 1 ? "" : "s"]) : t("wrote the answer")} <span className="ml-auto num">{s.duration_ms}{" "}{t("ms")}</span></li>;
          const r = s.result ?? {};
          const src = SOURCE[r.source] ?? SOURCE.callback;
          return (
            <li key={s.step} id={`fact-${r.fact}`} className={`rounded-[10px] border p-3 text-sm transition-colors ${highlight === r.fact ? "border-brand bg-brand-soft" : "border-line bg-surface"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-paper px-1.5 font-mono text-xs">{r.fact}</span>
                <span className="font-mono text-[0.8rem] font-semibold">{r.name}</span>
                <span className="inline-flex items-center gap-1 text-xs text-ink-2"><src.icon className="size-3.5" aria-hidden="true" />{t(src.label)}</span>
                <span className="ml-auto text-xs text-ink-2 num">{s.duration_ms}{" "}{t("ms")}</span>
              </div>
              <div className="mt-1 break-all font-mono text-xs text-ink-2">{r.args_summary}</div>
              <div className={`mt-1 break-words text-xs [overflow-wrap:anywhere] ${r.ok ? "" : "text-hold"}`}>{r.ok ? "" : t("Failed: ")}{r.summary}</div>
            </li>
          );
        })}
      </ol>
      {live ? <p className="flex items-center gap-2 text-xs text-ink-2"><Loader2 className="size-3.5 animate-spin" aria-hidden="true" />{t("Working…")}</p> : null}
    </div>
  );
}

function Answer({ steps, onCite }: { steps: Step[]; onCite: (f: string) => void }) {
  const ans = steps.find((s) => s.tool === "ask.answer")?.result;
  const failed = steps.find((s) => s.tool === "ask.failed")?.result;
  if (failed) return <Panel className="border-hold/40 p-4 text-sm" role="alert">{failed.message}</Panel>;
  if (!ans) return null;
  return (
    <Panel className="p-4">
      <ul className="space-y-2 text-[0.95rem]">
        {ans.sentences.map((x: any, i: number) => x.text ? (
          <li key={i} className="leading-relaxed">
            {x.text}{" "}
            {x.cites.map((c: string) => <button key={c} type="button" onClick={() => onCite(c)} className="ml-0.5 rounded bg-paper px-1 align-baseline font-mono text-[0.7rem] text-ink-2 hover:bg-brand-soft" aria-label={t("Show fact {0}", [c])}>{c}</button>)}
          </li>
        ) : <li key={i} className="text-xs text-hold">{x.removed}</li>)}
      </ul>
      <p className="mt-3 text-xs text-ink-2">{t("Each sentence links to the tool result it rests on. Code checked every amount against those results")}{ans.removed ? t("; {0} sentence{1} removed", [ans.removed, ans.removed === 1 ? " was" : "s were"]) : ""}.</p>
    </Panel>
  );
}

function Proposals({ items, reload }: { items: AskHome["proposals"]; reload: () => void }) {
  const open = items.filter((p) => p.status === "open");
  if (!open.length) return null;
  const go = (p: AskHome["proposals"][number]) => (p.kind === "policy_change" ? `/rules?draft=${encodeURIComponent(p.payload.text ?? "")}` : `/calls/${p.payload.call_id}`);
  const what: Record<string, string> = { skip_call: t("Skip a call"), call_now: t("Place a call now"), policy_change: t("Change the rules") };
  const done = async (id: string, act: "done" | "dismiss") => {
    try {
      await postJson(`/api/app/ask/proposals/${id}/${act}`);
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <Section id="proposals" title={t("Proposed by the AI")} hint={t("Nothing here has happened. Open one to do it yourself with the normal buttons, where code re-checks everything.")}>
      <ul className="space-y-2">{open.map((p) => (
        <li key={p.id}><Panel className="flex flex-wrap items-center gap-3 p-3 text-sm">
          <Lightbulb className="size-4 text-hold" aria-hidden="true" />
          <div className="min-w-0 flex-1"><b>{what[p.kind] ?? p.kind}</b>{p.kind === "policy_change" ? `: “${p.payload.text}”` : ""}<div className="text-xs text-ink-2">{p.reason} · {when(p.created_at)}</div></div>
          <Button asChild size="sm" variant="outline" className="min-h-11"><Link to={go(p)} onClick={() => void done(p.id, "done")}>{t("Open")}</Link></Button>
          <Button size="sm" variant="ghost" className="min-h-11" onClick={() => void done(p.id, "dismiss")} aria-label={t("Dismiss this proposal")}><X />{t("Dismiss")}</Button>
        </Panel></li>
      ))}</ul>
    </Section>
  );
}

export default function AskPage() {
  useTitle(t("Ask Callback"));
  const { data: d, error, loading, reload } = useData<AskHome>("/api/app/ask");
  const [q, setQ] = useState(() => new URLSearchParams(window.location.search).get("q")?.slice(0, 500) ?? ""); // /judge prefills it
  const dict = useDictation((t) => setQ(t.slice(0, 500)));
  const [runId, setRunId] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [live, setLive] = useState(false);
  const [hl, setHl] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const es = useRef<EventSource | null>(null);
  useEffect(() => () => es.current?.close(), []);

  const watch = (id: string) => {
    es.current?.close();
    setSteps([]);
    setLive(true);
    const src = new EventSource(`/api/app/ask/${id}/stream`);
    es.current = src;
    src.onmessage = (m) => {
      const s = JSON.parse(m.data) as Step;
      setSteps((xs) => (xs.some((x) => x.step === s.step) ? xs : [...xs, s].sort((a, b) => a.step - b.step)));
    };
    src.addEventListener("end", () => {
      src.close();
      setLive(false);
      reload();
    });
    src.onerror = () => {
      src.close();
      setLive(false);
      void fetch(`/api/app/ask/${id}`, { credentials: "same-origin", headers: { accept: "application/json" } }).then((r) => r.json()).then((j) => j.steps && setSteps(j.steps)).catch(() => undefined);
    };
  };
  const ask = async (question: string) => {
    if (!question.trim()) return;
    try {
      const r = await postJson<{ run_id: string }>("/api/app/ask", { question });
      setRunId(r.run_id);
      watch(r.run_id);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const cite = (f: string) => {
    setHl(f);
    if (matchMedia("(min-width: 1024px)").matches) document.getElementById(`fact-${f}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    else setSheet(true);
  };

  if (error && !d) return <ErrorState error={error} retry={reload} />;
  if (loading && !d) return <Rows n={3} />;
  if (!d) return null;
  const question = steps.find((s) => s.tool === "ask.question")?.args?.question;
  const toolCount = steps.filter((s) => s.tool === "ask.tool").length;
  return (
    <>
      <PageHead title={t("Ask Callback")} happened={t("Answers come from {0}, working through Callback's read tools and PayPal's MCP server. It can propose, never act.", [d.brain === "model" ? d.brain_label.split(" for ")[0] : "no model"])} />
      {d.brain !== "model" ? <Panel className="mb-6 p-4 text-sm" role="alert">{t("The AI model isn't available here, so Ask can't run. Nothing is answered by rules instead.")}</Panel> : null}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] [&>*]:min-w-0">
        <div>
          <Panel className="p-4" data-tour="ask-box">
            <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); void ask(q); }}>
              <Label htmlFor="ask-q">{t("Ask about your calls, customers, rules or PayPal")}</Label>
              <Textarea id="ask-q" rows={3} value={q} onChange={(e) => setQ(e.target.value)} className="text-base md:text-sm" placeholder={t("Who will you call today, and who won't you call?")} />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={live || d.brain !== "model"} aria-busy={live}>{live ? <Loader2 className="animate-spin" /> : <Send />}{t("Ask")}</Button>
                <Button type="button" variant="outline" onClick={() => void dict.toggle()} aria-pressed={dict.state === "on"} aria-describedby="ask-voice-note" disabled={live || dict.state === "starting"}>
                  {dict.state === "on" ? <MicOff /> : dict.state === "starting" ? <Loader2 className="animate-spin" /> : <Mic />}{dict.state === "on" ? t("Stop talking") : t("Talk instead")}
                </Button>
                {d.presets.map((p) => <Button key={p} type="button" variant="outline" size="sm" className="h-auto min-h-11 max-w-full shrink whitespace-normal py-2 text-left" disabled={live || d.brain !== "model"} onClick={() => { setQ(p); void ask(p); }}>{p}</Button>)}
              </div>
              <p id="ask-voice-note" className="text-sm text-ink-2" aria-live="polite">
                {dict.note || t("Talk instead types what you say into the box with gpt-live-1. Nothing is asked until you press Ask. Typing always works.")}
              </p>
            </form>
          </Panel>
          {runId ? (
            <Section id="answer" title={question ? `“${question}”` : t("Answer")} className="mt-6">
              <div className="mb-2 lg:hidden">
                <Sheet open={sheet} onOpenChange={setSheet}>
                  <SheetTrigger asChild><Button variant="outline" size="sm" className="min-h-11">{t("Show the AI's work ({0})", [plural(toolCount, "tool call")])}</Button></SheetTrigger>
                  <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
                    <SheetHeader><SheetTitle>{t("The AI's work")}</SheetTitle></SheetHeader>
                    <div className="px-4 pb-6"><Rail steps={steps} live={live} highlight={hl} /></div>
                  </SheetContent>
                </Sheet>
              </div>
              {live && !steps.some((s) => s.tool === "ask.answer" || s.tool === "ask.failed") ? <Panel className="p-4 text-sm text-ink-2">{t("Working through the tools…")}</Panel> : <Answer steps={steps} onCite={cite} />}
            </Section>
          ) : null}
          <Proposals items={d.proposals} reload={reload} />
          <Section id="recent" title={t("Earlier questions")} className="mt-6">
            {d.runs.length ? (
              <ul className="divide-y divide-line rounded-[10px] border border-line bg-surface">{d.runs.map((r) => (
                <li key={r.id}><button type="button" className="flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-surface-2" onClick={() => { setRunId(r.id); watch(r.id); }}>
                  <span className="min-w-0 flex-1 truncate">{r.subject}</span><StateChip s={r.status === "done" ? "done" : r.status === "running" ? "live" : "off"}>{r.status}</StateChip><span className="text-xs text-ink-2 num">{when(r.started_at)}</span>
                </button></li>
              ))}</ul>
            ) : <Empty title={t("No questions yet")}>{t("Try one of the questions above.")}</Empty>}
          </Section>
        </div>
        <aside className="hidden lg:block" aria-label={t("The AI's work")}>
          <div className="sticky top-4">
            <h2 className="mb-2 text-sm font-semibold">{t("The AI's work")}</h2>
            {runId ? <Rail steps={steps} live={live} highlight={hl} /> : <p className="text-sm text-ink-2">{t("Each tool the AI calls shows here as it runs: its name, what it asked for, how long it took and what came back.")}</p>}
          </div>
        </aside>
      </div>
    </>
  );
}
