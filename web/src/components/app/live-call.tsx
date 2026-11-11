import { useState } from "react";
import { Mic, MicOff, PhoneCall, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApprovalCard, type Approval } from "./approval";
import { Panel } from "./bits";
import { postJson } from "@/lib/api";
import { useLiveEvents, useLiveVoice } from "@/lib/voice";

export interface LiveVoiceInfo { live: boolean; model: string; on_now: boolean; transport: string | null; phone: boolean; phone_countries: string[]; phone_why_off: string | null; cap_seconds: number }
export interface SignalState { p: Record<string, number>; fired: Record<string, { p: number; at: string; source: string }>; source: string | null; not_run: string | null }

/** The nine questions asked about each customer turn (labels match src/voice/signals.ts). */
export const SIGNAL_LABELS: [string, string][] = [
  ["asked_to_stop_calls", "Asked to stop the calls"],
  ["agreed_to_pay_now", "Agreed to pay now"],
  ["asked_for_time_or_callback", "Asked for time or a callback"],
  ["disputes_the_debt", "Disputes the amount"],
  ["wrong_person", "Wrong person"],
  ["third_party_listening", "Someone else is listening"],
  ["distress_or_hardship", "Hardship or distress"],
  ["asks_who_is_calling", "Asked who is calling"],
  ["threat_or_abuse", "Threat or abuse"],
];
const ACTS: Record<string, string> = {
  asked_to_stop_calls: "Code ended the call and added them to do-not-call.",
  wrong_person: "Code ended the call without saying anything about the account.",
  threat_or_abuse: "Code ended the call.",
  disputes_the_debt: "Code stopped collection on this item and opened a review for you.",
  distress_or_hardship: "Code told the agent: plans or a callback only, no pressure.",
  third_party_listening: "Code told the agent: no amounts until the customer is happy to go on.",
};

/** Before the call: the three ways to take it yourself (spec B2 item 1), in the spec's order. */
export function TakeTheCall({ callId, voice, onChange, typeButton }: { callId: string; voice: LiveVoiceInfo; onChange: () => void; typeButton: React.ReactNode }) {
  const [number, setNumber] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const browser = useLiveVoice(callId, onChange);
  const ring = async () => {
    setBusy(true);
    try {
      const r = await postJson<{ message: string }>(`/api/app/calls/${callId}/live/phone`, { number, consent });
      toast.success(r.message);
      onChange();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel className="mb-6 p-4" data-tour="take-call">
      <h2 className="font-semibold">Take the call yourself</h2>
      <p className="mb-3 text-sm text-ink-2">You play the customer. The agent runs on {voice.model}; every amount and PayPal move still goes through the gate. Calls stop after {Math.round(voice.cap_seconds / 60)} minutes.</p>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-[10px] border border-line p-3">
          <h3 className="mb-1 flex items-center gap-1.5 font-medium"><PhoneCall className="size-4" aria-hidden="true" />Call my phone</h3>
          {voice.phone ? (
            <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); void ring(); }}>
              <Label htmlFor="cmp-number">Your number, with country code</Label>
              <Input id="cmp-number" type="tel" inputMode="tel" autoComplete="tel" placeholder="+61 4xx xxx xxx" value={number} onChange={(e) => setNumber(e.target.value)} required />
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 size-4" checked={consent} onChange={(e) => setConsent(e.target.checked)} required /><span>I agree to one demo call to this number from an AI agent. It is not stored.</span></label>
              <Button type="submit" disabled={busy || !consent || !number.trim()} aria-busy={busy}>Ring my phone</Button>
              <p className="text-xs text-ink-2">Numbers in {voice.phone_countries.join(", ")} only. One call per number an hour.</p>
            </form>
          ) : <p className="text-sm text-ink-2">Off on this deployment. {voice.phone_why_off}</p>}
        </div>
        <div className="rounded-[10px] border border-line p-3">
          <h3 className="mb-1 flex items-center gap-1.5 font-medium"><Mic className="size-4" aria-hidden="true" />Talk in the browser</h3>
          {voice.live ? (
            <>
              <p className="mb-2 text-sm text-ink-2">Uses your microphone. The agent says first that it is an AI and a demo.</p>
              <Button type="button" variant="outline" onClick={() => void browser.start()} disabled={browser.state === "starting"} aria-pressed={browser.state === "on"}>{browser.state === "on" ? <MicOff /> : <Mic />}{browser.state === "on" ? "Stop" : "Start talking"}</Button>
              {browser.note ? <p role="status" className="mt-2 text-sm text-ink-2">{browser.note}</p> : null}
            </>
          ) : <p className="text-sm text-ink-2">Off: no voice model key on this deployment.</p>}
        </div>
        <div className="rounded-[10px] border border-line p-3">
          <h3 className="mb-1 font-medium">Type instead</h3>
          <p className="mb-2 text-sm text-ink-2">The same agent and checks, by text. Works with a screen reader.</p>
          {typeButton}
        </div>
      </div>
    </Panel>
  );
}

/** During a live call: what is being said now, the owner's line, held moves to approve while they wait. */
export function LiveCallPanel({ callId, voice, approvals, passkey, onChange }: { callId: string; voice: LiveVoiceInfo; approvals: Approval[]; passkey: boolean; onChange: () => void }) {
  const ev = useLiveEvents(callId, true);
  const browser = useLiveVoice(callId, onChange);
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);
  const on = ev.live || voice.on_now;
  const say = async () => {
    setBusy(true);
    try {
      await postJson(`/api/app/calls/${callId}/live/say`, { text: line });
      setLine("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel className="mb-6 p-4" data-tour="live-call">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="lamp" data-s={on ? "live" : "idle"} aria-hidden="true" />
        <h2 className="font-semibold">{on ? `Live voice on ${voice.model}${voice.transport ? ` (${voice.transport === "phone" ? "phone" : voice.transport === "test-line" ? "test line" : "browser"})` : ""}` : "Listening for live voice"}</h2>
        <span className="text-xs text-ink-2">{ev.connected ? "following the call" : "connecting…"}</span>
      </div>
      <div className="space-y-1.5 text-sm" aria-live="polite" aria-relevant="additions text">
        {ev.lines.slice(-8).map((l, i) => <p key={i}><b>{l.who === "customer" ? "Customer" : l.who === "owner" ? "You" : "Agent"}:</b> {l.text}</p>)}
        {ev.partial.customer ? <p className="text-ink-2"><b>Customer (speaking):</b> {ev.partial.customer}</p> : null}
        {ev.partial.agent ? <p className="text-ink-2"><b>Agent (speaking):</b> {ev.partial.agent}</p> : null}
        {!ev.lines.length && !ev.partial.customer && !ev.partial.agent ? <p className="text-ink-2">{on ? "Waiting for the first words…" : "Nothing live yet. Typed turns show in the score below."}</p> : null}
      </div>
      {ev.notes.length ? <ul className="mt-2 space-y-0.5 text-xs text-ink-2">{ev.notes.slice(-3).map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
      {approvals.length ? (
        <div className="mt-3 space-y-2" role="region" aria-label="Held while the customer waits">
          <p className="text-sm font-medium text-hold">Held while the customer waits. The agent has said "one moment while I check".</p>
          {approvals.map((a) => <ApprovalCard key={a.id} a={a} passkey={passkey} onDone={onChange} compact />)}
        </div>
      ) : null}
      {on ? (
        <form className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(e) => { e.preventDefault(); void say(); }}>
          <div className="flex-1"><Label htmlFor="owner-say">Step in: the agent says this on the call</Label><Input id="owner-say" value={line} onChange={(e) => setLine(e.target.value)} maxLength={300} placeholder="Hi, it's the owner. I'm happy to help." /></div>
          <Button type="submit" disabled={busy || !line.trim()} aria-busy={busy}><Send />Say it</Button>
        </form>
      ) : voice.live && !voice.on_now ? (
        <div className="mt-3">
          <Button type="button" variant="outline" onClick={() => void browser.start()} disabled={browser.state === "starting"}><Mic />Switch this typed call to voice</Button>
          {browser.note ? <p role="status" className="mt-2 text-sm text-ink-2">{browser.note}</p> : null}
        </div>
      ) : null}
    </Panel>
  );
}

/** The transcript decisions, with probabilities, on the call score (spec B2 item 2). */
export function SignalStrip({ s }: { s: SignalState | null }) {
  if (!s) return <p className="text-sm text-ink-2">No transcript decisions yet. They are asked on every customer turn.</p>;
  const fired = SIGNAL_LABELS.filter(([n]) => s.fired?.[n]);
  return (
    <div className="rounded-[10px] border border-line p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-medium">Decisions on the transcript</h3><span className="text-xs text-ink-2">{s.not_run ? `Not run on the last turn: ${s.not_run}` : s.source ?? ""} · acts at 80%, a set line, not calibrated</span></div>
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {SIGNAL_LABELS.map(([n, label]) => {
          const p = s.p?.[n];
          const hit = Boolean(s.fired?.[n]);
          return (
            <li key={n} className="text-sm">
              <div className="flex justify-between gap-2"><span className={hit ? "font-semibold" : ""}>{label}</span><span className="num text-ink-2">{typeof p === "number" ? `${Math.round(p * 100)}%` : "n/a"}</span></div>
              <div className="h-1.5 rounded-full bg-surface-2" role="img" aria-label={`${label}: ${typeof p === "number" ? `${Math.round(p * 100)} percent` : "not asked yet"}${hit ? ", acted on" : ""}`}><div className={`h-1.5 rounded-full ${hit ? "bg-hold" : "bg-brand"}`} style={{ width: `${Math.round((p ?? 0) * 100)}%` }} /></div>
            </li>
          );
        })}
      </ul>
      {fired.length ? <ul className="mt-2 space-y-0.5 text-sm">{fired.map(([n, label]) => <li key={n}><b>{label}</b> ({Math.round((s.fired[n].p ?? 0) * 100)}%): {ACTS[n] ?? "Shown here; the agent handles it in the conversation."}</li>)}</ul> : null}
    </div>
  );
}
