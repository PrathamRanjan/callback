/** Pages a judge reads without signing in (spec A3.2). Each reads /api/public/*; nothing here is typed as live by hand. */
import { HandsFreeAbout, HandsFreeProof } from "@/handsfree/about";
import { ConnectAssistant } from "@/components/app/agent-connect";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Check, Copy, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PublicShell } from "@/components/app/public-shell";
import { ErrorState, Panel, Rows, Segmented } from "@/components/app/bits";
import { money, plural, when } from "@/lib/format";
import { useData, useTitle } from "@/lib/hooks";

import { t, tmap } from "@/i18n";
function Page({ title, lead, children }: { title: string; lead: ReactNode; children: ReactNode }) {
  useTitle(title);
  return (
    <PublicShell wide>
      <div className="mx-auto max-w-[1080px] px-4 py-8">
        <p className="text-sm"><Link to="/judge" className="underline">{t("For judges")}</Link></p>
        <h1 className="mt-1 break-words font-display text-h1 font-[800] hyphens-auto" style={{ fontStretch: "115%" }}>{title}</h1>
        <div className="mt-2 max-w-[72ch] text-ink-2">{lead}</div>
        <div className="mt-6 grid gap-6">{children}</div>
      </div>
    </PublicShell>
  );
}
function Load<T>({ path, children }: { path: string; children: (d: T) => ReactNode }) {
  const { data, error, loading, reload } = useData<T>(path);
  if (error && !data) return <ErrorState error={error} retry={reload} />;
  if (loading && !data) return <Rows n={5} />;
  return data ? <>{children(data)}</> : null;
}
const H2 = ({ children, id }: { children: ReactNode; id?: string }) => <h2 id={id} className="text-h2 font-semibold">{children}</h2>;
function Copyable({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-start gap-2 rounded-md border border-line bg-surface-2 p-3">
      <code className="min-w-0 flex-1 break-all font-mono text-xs">{text}</code>
      <Button type="button" size="sm" variant="outline" aria-label={t("Copy the command")} onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { toast.error(t("Couldn't copy here. Select the text instead.")); } }}>{done ? <Check /> : <Copy />} {done ? t("Copied") : t("Copy")}</Button>
    </div>
  );
}
const PassMark = ({ pass }: { pass: boolean }) => <span className="inline-flex items-center gap-1 whitespace-nowrap font-medium" style={{ color: pass ? "var(--lamp-done)" : "var(--lamp-hold, #b42318)" }}>{pass ? <Check className="size-4" /> : <X className="size-4" />}{pass ? t("Pass") : t("Fail")}</span>;

/* ---------- /proof ---------- */
interface EvalCase { id: string; input: string; expected: string; answer: string; pass: boolean; why: string }
interface EvalJob { job: string; model: string; cases: EvalCase[]; passed: number; total: number; note?: string }
interface ProofData {
  eval: { run_at: string; jobs: EvalJob[]; not_measured: string[] } | null;
  thresholds: { name: string; clear_below: number; hold_above: number; n: number; precision_at_hold: number | null; recall_at_hold: number | null; calibrated_on: string | null }[];
  models: { turn: string; decisions: string; label: string };
  nightly: boolean;
  runner: string;
  source: string;
}
export function PublicProof() {
  const [only, setOnly] = useState<"all" | "fail">("all");
  return (
    <Page title={t("Proof")} lead={<>{t("Every case in the AI evaluation: what went in, what was expected, what the model answered, and whether code judged it a pass. Nothing is summarised away.")}</>}>
      <Load<ProofData> path="/api/public/proof">
        {(d) => !d.eval ? <Panel className="p-4">{t("No evaluation file is published on this server yet.")}</Panel> : (
          <>
            <Panel className="p-4 text-sm">
              <p><b>{t("Run:")}</b> <span className="num">{new Date(d.eval.run_at).toISOString().slice(0, 16).replace("T", " ")}{" "}{t("UTC")}</span> ({when(d.eval.run_at)}). {d.nightly ? t("Written by the nightly GitHub workflow.") : d.runner.startsWith("github-actions") ? t("Run by the GitHub workflow, started by hand.") : t("Run by hand with npm run eval:ai and committed. A nightly GitHub workflow is in the repository but stays off until the owner adds the OpenAI key as a repository secret.")}</p>
              <p className="mt-1"><b>{t("Models:")}</b>{" "}{t("call turns and policy reading on")}{" "}{d.models.label}{t("; scam check on")}{" "}{d.models.decisions}{" "}{t("(OpenAI Decisions).")}</p>
              <p className="mt-1"><b>{t("Totals:")}</b> {d.eval.jobs.map((j) => `${j.job}: ${j.passed}/${j.total}`).join(" · ")}</p>
              <p className="mt-1 text-ink-2">{t("File:")}{" "}{d.source}</p>
            </Panel>
            <Segmented label={t("Show")} value={only} onChange={setOnly} options={[{ v: "all", label: t("Every case") }, { v: "fail", label: t("Failures only") }]} />
            {d.eval.jobs.map((j) => (
              <section key={j.job} className="grid gap-2" aria-labelledby={`job-${j.job}`}>
                <h2 id={`job-${j.job}`} className="text-h2 font-semibold">{j.job} <span className="num text-ink-2">{j.passed}/{j.total}</span></h2>
                <p className="text-sm text-ink-2">{t("Model:")}{" "}{j.model}{j.note ? `. ${j.note}` : ""}</p>
                <Panel className="overflow-x-auto">
                  <Table>
                    <TableHeader><TableRow><TableHead>{t("Case")}</TableHead><TableHead>{t("Input")}</TableHead><TableHead>{t("Expected")}</TableHead><TableHead>{t("Model's answer")}</TableHead><TableHead>{t("Result")}</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {j.cases.filter((c) => only === "all" || !c.pass).map((c) => (
                        <TableRow key={c.id} data-case={c.id}>
                          <TableCell className="num align-top font-mono text-xs">{c.id}</TableCell>
                          <TableCell className="min-w-[220px] align-top text-sm">{c.input}</TableCell>
                          <TableCell className="min-w-[160px] align-top text-sm">{c.expected}</TableCell>
                          <TableCell className="min-w-[220px] align-top text-sm">{c.answer}</TableCell>
                          <TableCell className="align-top text-sm"><PassMark pass={c.pass} />{c.why ? <span className="mt-1 block text-xs text-ink-2">{c.why}</span> : null}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Panel>
              </section>
            ))}
            <section className="grid gap-2">
              <H2>{t("Scam-check thresholds")}</H2>
              <p className="text-sm text-ink-2">{t("Each yes/no question's probability is read against two thresholds set by scripts/calibrate.ts on the tuning half (a miss costs five times a false hold). Below \"clear\" counts as no; above \"hold\" counts as yes; between them is \"unsure\", which never shows green.")}</p>
              <Panel className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow><TableHead>{t("Question")}</TableHead><TableHead className="text-right">{t("Clear below")}</TableHead><TableHead className="text-right">{t("Hold above")}</TableHead><TableHead className="text-right">{t("Examples")}</TableHead><TableHead className="text-right">{t("Precision")}</TableHead><TableHead className="text-right">{t("Recall")}</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {d.thresholds.map((t) => (
                      <TableRow key={t.name}>
                        <TableCell className="font-mono text-xs">{t.name}</TableCell>
                        <TableCell className="num text-right">{t.clear_below}</TableCell>
                        <TableCell className="num text-right">{t.hold_above}</TableCell>
                        <TableCell className="num text-right">{t.n}</TableCell>
                        <TableCell className="num text-right">{t.precision_at_hold ?? "—"}</TableCell>
                        <TableCell className="num text-right">{t.recall_at_hold ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Panel>
            </section>
            <section className="grid gap-2">
              <H2>{t("Not measured")}</H2>
              <ul className="list-disc pl-5 text-sm">{d.eval.not_measured.map((n) => <li key={n}>{n}</li>)}</ul>
            </section>
          </>
        )}
      </Load>
      <section className="grid gap-2">
        <H2>{t("Hands-free")}</H2>
        <HandsFreeProof />
      </section>
    </Page>
  );
}

/* ---------- /ai ---------- */
interface AiRow { id: string; purpose: string; model: string; via: string; input: string; output: string; error: string | null; ok: boolean; latency_ms: number; tokens_in: number; tokens_out: number; cost_usd: number; at: string }
const PURPOSE: Record<string, string> = tmap({ turn: "Call turn", policy: "Policy reading", persona: "Persona", summary: "Summary", eval: "Evaluation", scam_check: "Scam check", agent: "Ask agent step", translate: "Translation" });
function AiTable({ rows }: { rows: AiRow[] }) {
  if (!rows.length) return <Panel className="p-4 text-sm text-ink-2">{t("No model calls recorded here yet.")}</Panel>;
  return (
    <Panel className="overflow-x-auto">
      <Table>
        <TableHeader><TableRow><TableHead>{t("When")}</TableHead><TableHead>{t("Job")}</TableHead><TableHead>{t("Model")}</TableHead><TableHead>{t("Input")}</TableHead><TableHead>{t("Output or tool calls")}</TableHead><TableHead className="text-right">{t("Latency")}</TableHead><TableHead className="text-right">{t("Cost")}</TableHead></TableRow></TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="whitespace-nowrap align-top text-xs">{when(r.at)}</TableCell>
              <TableCell className="align-top text-sm">{PURPOSE[r.purpose] ?? r.purpose}{r.via === "replay" ? <span className="block text-xs text-ink-2">{t("replayed from an earlier answer")}</span> : null}</TableCell>
              <TableCell className="align-top font-mono text-xs">{r.model}</TableCell>
              <TableCell className="min-w-[160px] align-top text-sm">{r.input || <span className="text-ink-2">—</span>}</TableCell>
              <TableCell className="min-w-[220px] align-top text-sm">{r.ok ? r.output : <span>{t("Failed:")}{" "}{r.error}</span>}</TableCell>
              <TableCell className="num whitespace-nowrap text-right align-top">{(r.latency_ms / 1000).toFixed(1)} s</TableCell>
              <TableCell className="num whitespace-nowrap text-right align-top">${r.cost_usd.toFixed(4)}<span className="block text-xs text-ink-2">{r.tokens_in}{" "}{t("in ·")}{" "}{r.tokens_out}{" "}{t("out")}</span></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}
export function PublicAi() {
  return (
    <Page title={t("AI calls")} lead={<>{t("The last 20 model calls, as the app recorded them: the job, the model, what it was asked about, what came back, how long it took and what it cost. Costs are estimated from token counts and the published price list. Inputs are recorded as a hash; the column shows the run's subject.")}</>}>
      <Load<{ showcase: AiRow[]; yours: AiRow[] | null; recent: AiRow[]; models: { label: string; decisions: string } }> path="/api/public/ai">
        {(d) => (
          <>
            {d.yours ? <section className="grid gap-2"><H2>{t("Your demo")}</H2><AiTable rows={d.yours} /></section> : null}
            <section className="grid gap-2"><H2>{t("Other visitors' demos")}</H2><p className="text-sm text-ink-2">{t("The latest model calls in other people's private copies. What they typed and what came back are not shown; tool names, models, timings and costs are.")}</p><AiTable rows={d.recent} /></section>
            <section className="grid gap-2"><H2>{t("Showcase studio")}</H2><p className="text-sm text-ink-2">{t("The shared studio nobody signs in to, so it rarely has model calls of its own.")}</p><AiTable rows={d.showcase} /></section>
          </>
        )}
      </Load>
    </Page>
  );
}

/* ---------- /paypal ---------- */
interface PayPalData { env: string; configured: boolean; apis: { api: string; endpoint: string; when: string; label: string; live: { id: string; at: string; where: string; extra: string | null } | null; error: boolean }[]; mcp_tools: string[] }
export function PublicPayPal() {
  return (
    <Page title={t("PayPal")} lead={<>{t("Every PayPal API Callback uses, the moment it is used, and the latest id PayPal returned for it, read from the database now. Ids come from your own demo when it has one, otherwise from the showcase studio or another visitor's recent demo (only the PayPal id is shown).")}</>}>
      <Load<PayPalData> path="/api/public/paypal">
        {(d) => (
          <>
            <p className="text-sm">{t("Environment:")}{" "}<b>{d.env}</b>. {d.configured ? t("Credentials are configured on this server.") : t("No PayPal credentials on this server: every money move fails and says so.")}</p>
            <Panel className="overflow-x-auto">
              <Table>
                <TableHeader><TableRow><TableHead>{t("API")}</TableHead><TableHead>{t("When Callback calls it")}</TableHead><TableHead>{t("Latest live id")}</TableHead></TableRow></TableHeader>
                <TableBody>
                  {d.apis.map((a) => (
                    <TableRow key={a.api}>
                      <TableCell className="min-w-[200px] align-top"><span className="font-medium">{a.api}</span><span className="mt-1 block font-mono text-xs text-ink-2">{a.endpoint}</span></TableCell>
                      <TableCell className="min-w-[200px] align-top text-sm">{a.when}</TableCell>
                      <TableCell className="align-top text-sm">{a.live ? <><span className="font-mono text-xs break-all">{a.live.id}</span><span className="block text-xs text-ink-2">{a.label}{a.live.extra ? ` (${a.live.extra})` : ""}, {a.live.where}, {when(a.live.at)}</span></> : a.error ? <span>{t("Couldn't read this just now")}</span> : a.label ? <span className="text-ink-2">{t("None recorded yet")}</span> : <span className="text-ink-2">{t("No id (a token)")}</span>}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Panel>
            <section className="grid gap-2">
              <H2>{t("PayPal's MCP server: the tools Ask may use")}</H2>
              <p className="text-sm text-ink-2">{t("PayPal's server lists more tools, including ones that create orders and refunds, and marks none of them read-only. Callback allows only these names in code and refuses any other before it is sent.")}</p>
              <ul className="flex flex-wrap gap-2">{d.mcp_tools.map((t) => <li key={t} className="rounded-md border border-line px-2 py-1 font-mono text-xs">{t}</li>)}</ul>
            </section>
          </>
        )}
      </Load>
    </Page>
  );
}

/* ---------- /who-can-move-money ---------- */
interface Facts { roles: { who: string; can: string[]; cannot: string[] }[]; limits: { auto_charge_max_cents: number; auto_refund_max_cents: number; auto_discount_max_pct: number; max_discount_pct: number; min_instalment_cents: number; countersign_above_cents: number } | null; mcp: { owner: string; customer: string; llms: string; skill: string } }
export function WhoCanMoveMoney() {
  return (
    <Page title={t("Who can move money")} lead={<>{t("Code, not the AI, decides what money may move. Every move passes one gate: kill switches, whole-cent amounts, where the amount came from (an amount that appears only in speech is refused), the owner's rules and limits, and PayPal's live state.")}</>}>
      <Load<Facts> path="/api/public/facts">
        {(d) => (
          <>
            {d.limits ? (
              <Panel className="p-4 text-sm">
                <p className="font-medium">{t("The showcase studio's limits, read from its settings now")}</p>
                <ul className="mt-2 grid gap-1">
                  <li>{t("Charges up to")}{" "}<b className="num">{money(d.limits.auto_charge_max_cents)}</b>{" "}{t("go through on their own; anything more is held for the owner.")}</li>
                  <li>{t("Refunds up to")}{" "}<b className="num">{money(d.limits.auto_refund_max_cents)}</b>{" "}{t("go through on their own, and only back to the payment they came from.")}</li>
                  <li>{t("Discounts: the rules allow up to")}{" "}<b className="num">{d.limits.max_discount_pct}%</b>{t("; the agent may offer up to")}{" "}<b className="num">{d.limits.auto_discount_max_pct}%</b>{" "}{t("without asking.")}</li>
                  <li>{t("Payment plans: no payment under")}{" "}<b className="num">{money(d.limits.min_instalment_cents)}</b>.</li>
                  <li>{t("Approvals of")}{" "}<b className="num">{money(d.limits.countersign_above_cents)}</b>{" "}{t("or more need the owner's passkey once one is registered.")}</li>
                </ul>
              </Panel>
            ) : null}
            <Panel className="overflow-x-auto">
              <Table>
                <TableHeader><TableRow><TableHead>{t("Who")}</TableHead><TableHead>{t("Can")}</TableHead><TableHead>{t("Cannot")}</TableHead></TableRow></TableHeader>
                <TableBody>
                  {d.roles.map((r) => (
                    <TableRow key={r.who}>
                      <TableCell className="min-w-[180px] align-top font-medium">{r.who}</TableCell>
                      <TableCell className="min-w-[220px] align-top text-sm"><ul className="grid gap-1">{r.can.map((c) => <li key={c} className="flex gap-1.5"><Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{c}</li>)}</ul></TableCell>
                      <TableCell className="min-w-[220px] align-top text-sm"><ul className="grid gap-1">{r.cannot.map((c) => <li key={c} className="flex gap-1.5"><X className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{c}</li>)}</ul></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Panel>
          </>
        )}
      </Load>
    </Page>
  );
}

/* ---------- /accessibility ---------- */
interface A11yRun {
  at: string;
  commit: string | null;
  base: string;
  tags: string[];
  axe?: { page: string; who: string; width: number; theme: string; serious: number; critical: number; minor_or_moderate: number; rules: string[] }[];
  reflow?: { page: string; who: string; condition: string; over_px: number }[];
  motion?: { pages: string[]; running_animations: number } | null;
  keyboard?: { flow: string; tabs: number; steps: string[]; result: string; without_visible_focus: number } | null;
  switches?: { checked: { name: string; described: boolean }[]; close_button: string } | null;
  live_region?: { count: number; announces: string } | null;
  sections?: Record<string, string>;
}

/** The recorded run of e2e/a11y.spec.ts (eval/a11y.json), check by check, each with the time it ran. */
function A11yChecks({ run }: { run: A11yRun }) {
  const axe = run.axe ?? [];
  const bad = axe.reduce((n, a) => n + a.serious + a.critical, 0);
  const minor = axe.reduce((n, a) => n + a.minor_or_moderate, 0);
  const reflow = run.reflow ?? [];
  const over = reflow.filter((r) => r.over_px > 0);
  const at = (k: string) => (run.sections?.[k] ? when(run.sections[k]) : when(run.at));
  const item = (pass: boolean, title: string, k: string, body: ReactNode) => (
    <li><Panel className="p-3 text-sm"><div className="flex flex-wrap items-baseline gap-x-2"><PassMark pass={pass} /><b>{title}</b><span className="text-ink-2">{at(k)}</span></div><div className="mt-1">{body}</div></Panel></li>
  );
  return (
    <>
      <p className="text-sm text-ink-2">{t("Run by the end-to-end suite (")}<code className="font-mono text-xs">e2e/a11y.spec.ts</code>{t(") against")}{" "}{run.base}{run.commit ? <>{t(", commit")}{" "}<code className="font-mono text-xs">{run.commit}</code></> : null}{t(". Rules:")}{" "}{run.tags.join(", ")}.</p>
      <ul className="grid gap-2">
        {axe.length ? item(bad === 0, t("axe-core on every page of every persona"), "axe", <>{axe.length}{" "}{t("page views (a stranger, the owner, the front desk and a customer; light at 1280 px and dark at 375 px):")}{" "}{bad}{" "}{t("serious or critical issues")}{minor ? t(", {0} minor or moderate", [minor]) : ""}. {bad ? <>{t("Failing:")}{" "}{axe.filter((a) => a.serious + a.critical).map((a) => `${a.page} (${a.rules.join(", ")})`).join("; ")}</> : null}</>) : null}
        {reflow.length ? item(over.length === 0, t("No sideways scroll at 320 px with Largest text, nor at 200% zoom"), "reflow", <>{reflow.length}{" "}{t("checks on")}{" "}{new Set(reflow.map((r) => r.page)).size}{" "}{t("pages. 200% zoom is measured as a 640 px window, the layout width 200% zoom gives on a 1280 px screen. Wide data tables scroll inside their own box.")}{" "}{over.length ? <>{t("Sideways:")}{" "}{over.map((r) => `${r.page} ${r.condition} by ${r.over_px} px`).join("; ")}</> : null}</>) : null}
        {run.motion ? item(run.motion.running_animations === 0, t("Nothing moves when the system asks for less motion"), "motion", <>{run.motion.running_animations}{" "}{t("running animations on")}{" "}{run.motion.pages.join(", ")}.</>) : null}
        {run.keyboard ? item(run.keyboard.without_visible_focus === 0, t("Keyboard only: the owner approves a held move"), "keyboard", <>{run.keyboard.flow}: {plural(run.keyboard.tabs, "Tab press", "Tab presses")}{" "}{t("from the top of the page, then Enter;")}{" "}{run.keyboard.result}{t(". Focus order:")}{" "}{run.keyboard.steps.join(" → ")}. {run.keyboard.without_visible_focus}{" "}{t("controls without a visible focus ring.")}</>) : null}
        {run.switches ? item(run.switches.checked.every((s) => s.described), t("Display and help switches have names and descriptions"), "switches", <>{run.switches.checked.map((s) => s.name).join(", ")}{t("; the close button is named “")}{run.switches.close_button}”.</>) : null}
        {run.live_region ? item(run.live_region.count === 1, t("One polite live region for payment status"), "live_region", <>{run.live_region.announces}.</>) : null}
      </ul>
    </>
  );
}

export function AccessibilityPage() {
  return (
    <Page title={t("Accessibility")} lead={<>{t("What was tested, how, and what was not. Results are from the dates shown; they are not re-run when you open this page.")}</>}>
      <section className="grid gap-2">
        <H2>{t("Built in")}</H2>
        <p className="text-sm">A <b>{t("Display and help")}</b>{" "}{t("button on every page, the customer's included: text size, high contrast, an easier-to-read font (Atkinson Hyperlegible), read aloud, voice input where the browser supports it on the device, plain words, bigger targets, more time and no motion. Choices stay in this browser. Every page has a skip link and a visible focus ring. Status lamps always carry a word for screen readers, never colour alone.")}</p>
      </section>
      <HandsFreeAbout />
      <section className="grid gap-2">
        <H2>{t("Automated checks, last run")}</H2>
        <Load<{ run: A11yRun | null }> path="/api/public/a11y">
          {({ run }) => (run ? <A11yChecks run={run} /> : <p className="text-sm">{t("No recorded run is shipped with this build. The checks are in")}{" "}<code className="font-mono text-xs">e2e/a11y.spec.ts</code>.</p>)}
        </Load>
      </section>
      <section className="grid gap-2">
        <H2>{t("Earlier checks by hand")}</H2>
        <ul className="grid gap-2 text-sm">
          <li><Panel className="p-3"><PassMark pass /> <b>{t("axe-core on the live site")}</b>{t(", 11 Nov 2026: Calls, Money, Proof, Messages, Rules, For judges, AI calls, PayPal, Who can move money, Accessibility and For AI agents, at 375 px light and 1280 px dark. The first run found wide tables a keyboard could not scroll and two small links; both were fixed before release.")}</Panel></li>
          <li><Panel className="p-3"><PassMark pass /> <b>{t("Tours")}</b>{" "}{t("start only from a button, end on any page change, and never move you to another page (end-to-end suite).")}</Panel></li>
        </ul>
      </section>
      <section className="grid gap-2">
        <H2>{t("Not tested")}</H2>
        <ul className="list-disc pl-5 text-sm">
          <li>{t("No screen-reader session (VoiceOver, TalkBack, NVDA) by a person has been run. The checks above are automated: they find missing names and roles, not whether the pages are pleasant to use with a screen reader.")}</li>
          <li>{t("No testing with disabled users.")}</li>
          <li>{t("Voice input on Ask (gpt-live-1) was checked by a robot that fed GPT-Live a recorded question; no person has tried it in a browser yet. Read aloud was tried only in desktop Chrome.")}</li>
          <li>{t("Taking a call by voice (phone or browser) was checked for what it says and does, not for accessibility.")}</li>
          <li>{t("Contrast is checked only by axe's rules on the pages listed, in the default and dark themes.")}</li>
          <li>{t("Hands-free has not been tried by a person with a real camera: gaze and head pointing, wink and calibration accuracy on real eyes are unmeasured. The end-to-end tests use simulated gaze and Chromium's fake camera. Voice commands were tested through the same code path with typed text, not a microphone.")}</li>
        </ul>
      </section>
    </Page>
  );
}

/* ---------- /agents ---------- */
export function Agents() {
  return (
    <Page title={t("For AI agents")} lead={<>{t("An outside assistant can use Callback over MCP. It gets the same gate, rules and limits as the owner: anything over the limits is held for the owner's approval, whoever asked.")}</>}>
      <ConnectAssistant />
      <Load<Facts> path="/api/public/facts">
        {(d) => (
          <>
            <section className="grid gap-2">
              <H2>{t("The owner's server")}</H2>
              <p className="text-sm">{t("Streamable HTTP at")}{" "}<code className="font-mono text-xs">{d.mcp.owner}</code>{" "}{t("with the owner's key as a Bearer token. In a demo the key is on Demo controls → Access keys (shown to the owner only). Read tools (plan, calls, customers, consent records, rules, approvals, traces) are marked read-only; place_call, skip_call, draft_policy and decide_approval go through the gate.")}</p>
              <Copyable text={`claude mcp add --transport http callback ${d.mcp.owner} --header "Authorization: Bearer <owner key>"`} />
            </section>
            <section className="grid gap-2">
              <H2>{t("A customer's own server")}</H2>
              <p className="text-sm">{t("Each customer's link has its own MCP server at")}{" "}<code className="font-mono text-xs">{d.mcp.customer}</code>{t(", with no key: their balance, their pay link, call-back times and a stop button. Nothing about anyone else.")}</p>
              <Copyable text={`claude mcp add --transport http my-studio ${d.mcp.customer}`} />
            </section>
            <section className="grid gap-2">
              <H2>{t("Read first")}</H2>
              <ul className="grid gap-1 text-sm"><li><a className="inline-flex min-h-11 items-center underline" href={d.mcp.llms}>{d.mcp.llms}</a></li><li><a className="inline-flex min-h-11 items-center underline" href={d.mcp.skill}>{d.mcp.skill}</a></li></ul>
            </section>
            <p className="text-sm text-ink-2">{t("Callback's own Ask agent uses the owner server's read tools in-process and PayPal's MCP server for PayPal's records.")}</p>
          </>
        )}
      </Load>
    </Page>
  );
}
