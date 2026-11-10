import { useRef, useState } from "react";
import { Loader2, ScanSearch, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ActButton, Empty, ErrorState, PageHead, Panel, Rows, Section, StateChip } from "@/components/app/bits";
import { postJson } from "@/lib/api";
import { money, when, word } from "@/lib/format";
import { useData, useTitle } from "@/lib/hooks";
import type { LampState } from "@/lib/format";

interface Scan { level: "hold" | "caution" | "clear"; reasons: string[]; tactics: string[]; risk?: number }
interface SafetyData {
  protected: { on: boolean; contacts: string[] };
  holds: { id: string; action: string; status: string; cents: number; reasons: string[]; rule: string | null; created_at: string }[];
  inbound: { channel: string; address: string; body: string; created_at: string; scan: Scan }[];
  replaced: number; verified_calls: number; demo_message: string | null;
}
const WORDS: Record<string, string> = {
  impersonation: "claims to be an authority, a bank or your boss", urgency_secrecy: "pushes you to act fast or keep it quiet", changed_details: "asks you to pay to new bank or PayPal details",
  off_platform: "asks to pay outside PayPal or move the chat elsewhere", gift_cards_crypto: "asks for gift cards or crypto", fee_to_release: "asks for a fee to release money or goods",
  otp_or_link: "asks for a code or sends a link to click", overpay_refund: "says they overpaid and wants the difference back", too_good: "promises a prize or guaranteed profit",
};
const LEVEL: Record<string, [LampState, string]> = { hold: ["off", "Hold: don't pay or reply yet"], caution: ["hold", "Caution: check before you act"], clear: ["done", "No scam signals found"] };

/** The fine-tuned text model runs in this browser (onnxruntime-web, int8, 23 MB, downloaded once). */
let guardP: Promise<{ score: (t: string) => Promise<{ p_scam: number; level: string; tactics: Record<string, number> }> }> | null = null;
function loadModel() {
  if (guardP) return guardP;
  guardP = new Promise<void>((ok, bad) => {
    if ((window as any).ort) return ok();
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.22.0/ort.min.js";
    s.onload = () => ok();
    s.onerror = () => bad(new Error("The model runtime didn't load."));
    document.head.appendChild(s);
  }).then(async () => {
    const ort = (window as any).ort;
    ort.env.wasm.wasmPaths = "https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.22.0/";
    const url = "/static/safety/guard-client.js";
    const mod = await import(/* @vite-ignore */ url);
    return mod.loadGuard({ modelUrl: "/static/safety/model/model_quantized.onnx", tokenizerUrl: "/static/safety/model/tokenizer.json", headsUrl: "/static/safety/model/heads.json", ort });
  });
  guardP.catch(() => (guardP = null));
  return guardP;
}

function Checker({ demo }: { demo: string | null }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ level: string; rules: Scan | null; model: { p_scam: number; level: string; tactics: Record<string, number> } | null; modelErr: string | null; ms: number } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const check = async () => {
    const t = text.trim();
    if (!t) return area.current?.focus();
    setBusy(true);
    setRes(null);
    setStatus("Checking with the rules…");
    let rules: Scan | null = null;
    let model: any = null;
    let modelErr: string | null = null;
    let ms = 0;
    try {
      rules = await postJson<Scan>("/safety/scan", { text: t });
    } catch (e) {
      rules = null;
      modelErr = (e as Error).message;
    }
    try {
      setStatus(guardP ? "Scoring in your browser…" : "Loading the model into your browser (23 MB, once)…");
      const g = await loadModel();
      const t0 = performance.now();
      model = await g.score(t);
      ms = performance.now() - t0;
    } catch (e) {
      modelErr = (e as Error).message;
    }
    const modelOnly = model?.level === "caution" && (!rules?.level || rules.level === "clear") && !Object.values(model?.tactics ?? {}).some((p: any) => p >= 0.5);
    const levels = [rules?.level, model?.level];
    const level = levels.includes("hold") ? "hold" : modelOnly ? "clear" : levels.includes("caution") ? "caution" : "clear";
    setRes({ level, rules, model, modelErr, ms });
    setStatus("");
    setBusy(false);
  };
  const tactics = res ? new Set([...(res.rules?.tactics ?? []), ...Object.entries(res.model?.tactics ?? {}).filter(([, p]) => p >= 0.5).map(([k]) => k)]) : new Set<string>();
  return (
    <Panel className="p-4" data-tour="scam-scan">
      <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); void check(); }}>
        <Label htmlFor="scan">Paste an email, text or chat message</Label>
        <Textarea id="scan" ref={area} rows={5} value={text} onChange={(e) => setText(e.target.value)} className="text-base md:text-sm" placeholder="Paste the message here" />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy} aria-busy={busy}>{busy ? <Loader2 className="animate-spin" /> : <ScanSearch />}Check this message</Button>
          {demo ? <Button type="button" variant="outline" onClick={() => setText(demo)}>Paste the demo scam</Button> : null}
          <span role="status" className="text-sm text-ink-2">{status}</span>
        </div>
        <p className="text-xs text-ink-2">The model scores the words on this device. The rules check runs on the server and keeps nothing.</p>
      </form>
      {res ? (
        <div className="mt-4 space-y-3 border-t border-line pt-4" aria-live="polite">
          <StateChip s={LEVEL[res.level][0]}>{LEVEL[res.level][1]}</StateChip>
          <dl className="grid grid-cols-3 gap-2 text-sm">
            <div className="rounded-[8px] bg-paper p-2"><dt className="text-xs text-ink-2">Text model</dt><dd className="font-semibold num">{res.model ? `${Math.round(res.model.p_scam * 100)}%` : "—"}</dd><dd className="text-xs text-ink-2">{res.model ? `${res.ms.toFixed(0)} ms here` : res.modelErr ?? "not run"}</dd></div>
            <div className="rounded-[8px] bg-paper p-2"><dt className="text-xs text-ink-2">Rules</dt><dd className="font-semibold">{res.rules?.level ?? "—"}</dd><dd className="text-xs text-ink-2">{res.rules?.reasons.length ? `${res.rules.reasons.length} reason${res.rules.reasons.length > 1 ? "s" : ""}` : "none fired"}</dd></div>
            <div className="rounded-[8px] bg-paper p-2"><dt className="text-xs text-ink-2">Risk model</dt><dd className="font-semibold num">{res.rules?.risk !== undefined ? `${Math.round(res.rules.risk * 100)}%` : "—"}</dd><dd className="text-xs text-ink-2">synthetic training data</dd></div>
          </dl>
          {tactics.size ? <div><h4 className="text-sm font-semibold">What this message does</h4><ul className="list-disc pl-5 text-sm">{[...tactics].map((k) => <li key={k}>{WORDS[k] ?? k}</li>)}</ul></div> : null}
          {res.rules?.reasons.length ? <div><h4 className="text-sm font-semibold">Why</h4><ul className="list-disc pl-5 text-sm">{res.rules.reasons.map((r) => <li key={r}>{r}</li>)}</ul></div> : null}
          <p className="text-sm text-ink-2">Pay only to details you confirmed by phone on a number you already had. Never share codes. {res.level === "clear" ? "A clear result isn't a guarantee: the model catches about three quarters of scams at this setting." : ""}</p>
        </div>
      ) : null}
    </Panel>
  );
}

export default function SafetyPage() {
  useTitle("Scam guard");
  const { data: d, error, loading, reload } = useData<SafetyData>("/api/app/safety");
  const [c1, setC1] = useState<string | null>(null);
  const [c2, setC2] = useState<string | null>(null);
  if (error && !d) return <ErrorState error={error} retry={reload} />;
  if (loading && !d) return <Rows n={4} />;
  if (!d) return null;
  return (
    <>
      <PageHead
        title="Scam guard"
        happened={`${d.verified_calls} call${d.verified_calls === 1 ? "" : "s"} carried a verify code; ${d.replaced} unsafe agent line${d.replaced === 1 ? " was" : "s were"} replaced.`}
        needs={d.holds.some((h) => h.status === "pending") ? "A move the scam guard paused is waiting on Needs you." : undefined}
        next="Rules in code, a text model in your browser and a payment-risk model. The strictest wins; none of them can approve a payment."
      />
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Section id="check" title="Check a message"><Checker demo={d.demo_message} /></Section>
        <Section id="how" title="How calls protect your customers">
          <Panel className="p-4">
            <ul className="space-y-3 text-sm">
              <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 flex-none text-done" /><span><b>A code they can check.</b> Every call opens with a four-digit code that's also on the customer's own page, so they can tell Callback from someone pretending to be you.</span></li>
              <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 flex-none text-done" /><span><b>Never asks for secrets.</b> Each line the agent is about to say is scanned; a line asking for a code, password or card number is replaced and counted.</span></li>
              <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 flex-none text-done" /><span><b>Refunds go back where the money came from.</b> A request to refund to a different account waits for you.</span></li>
              <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 flex-none text-done" /><span><b>Nobody changes your payout details by message.</b> A message claiming to be you and asking to move money is recorded and refused.</span></li>
            </ul>
          </Panel>
        </Section>
      </div>
      <Section id="protected" title="Protected mode" hint="Every refund and discount waits for you, holds are explained calmly with no timers, and a trusted contact hears about each hold.">
        <Panel className="flex flex-col gap-3 p-4 md:flex-row md:items-end">
          <StateChip s={d.protected.on ? "done" : "idle"}>{d.protected.on ? "On" : "Off"}</StateChip>
          <div className="grid flex-1 gap-1.5"><Label htmlFor="pc1">Trusted contact (Telegram chat id, optional)</Label><Input id="pc1" className="h-11" value={c1 ?? d.protected.contacts[0] ?? ""} onChange={(e) => setC1(e.target.value)} placeholder="telegram:123456789" /></div>
          <div className="grid flex-1 gap-1.5"><Label htmlFor="pc2">Second contact</Label><Input id="pc2" className="h-11" value={c2 ?? d.protected.contacts[1] ?? ""} onChange={(e) => setC2(e.target.value)} /></div>
          <ActButton path="/safety/protected" fields={{ on: d.protected.on ? "0" : "1", contact1: c1 ?? d.protected.contacts[0] ?? "", contact2: c2 ?? d.protected.contacts[1] ?? "" }} variant={d.protected.on ? "outline" : "default"} onDone={reload}>{d.protected.on ? "Turn off" : "Turn on"}</ActButton>
        </Panel>
      </Section>
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <Section id="holds" title="Moves the scam guard paused">
          {d.holds.length ? (
            <ul className="space-y-2">{d.holds.map((h) => <li key={h.id}><Panel className="p-3 text-sm"><div className="flex items-center justify-between gap-2"><b>{h.action} {money(h.cents)}</b><StateChip s={h.status === "pending" ? "hold" : h.status === "approved" ? "done" : "off"}>{word(h.status)}</StateChip></div>{h.reasons.length ? <ul className="mt-1 list-disc pl-5 text-ink-2">{h.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}<div className="mt-1 text-xs text-ink-2 num">{when(h.created_at)}</div></Panel></li>)}</ul>
          ) : <Empty title="Nothing paused">Payments that look like a scam stop here.</Empty>}
        </Section>
        <Section id="inbound" title="Messages received">
          {d.inbound.length ? (
            <ul className="space-y-2">{d.inbound.map((m, i) => <li key={i}><Panel className="p-3 text-sm"><div className="mb-1 flex items-center gap-2"><StateChip s={LEVEL[m.scan.level][0]}>{m.scan.level === "clear" ? "Clear" : m.scan.level === "hold" ? "Looks like a scam" : "Check first"}</StateChip><span className="text-xs text-ink-2">{m.channel} · {when(m.created_at)}</span></div><p className="line-clamp-3">{m.body}</p>{m.scan.level !== "clear" && m.scan.reasons[0] ? <p className="mt-1 text-xs text-hold">{m.scan.reasons[0]}</p> : null}</Panel></li>)}</ul>
          ) : <Empty title="No messages yet" />}
        </Section>
      </div>
    </>
  );
}
