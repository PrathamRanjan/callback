import { useRef, useState } from "react";
import { Loader2, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Panel, StateChip } from "@/components/app/bits";
import { postJson } from "@/lib/api";
import type { LampState } from "@/lib/format";

/**
 * The scam check (spec A6.1, A6.2). Readers look at the same message and the strictest wins:
 * the text model on this device, and (unless `deviceOnly`) the server's rules, the AI Decisions check and the code that
 * compares any place to pay with the business's record. Green appears only when every reader ran and was clear and
 * nothing names a place to pay. A reader that didn't run is shown as "not run", never as clear.
 */
export interface ServerScan {
  level: "hold" | "caution" | "clear";
  reasons: string[];
  tactics: string[];
  risk?: number;
  all_clear_allowed: boolean;
  names_destination: boolean;
  readers: {
    rules: { level: string; reasons: string[] };
    decisions: { level: string; model: string | null; ms: number | null; why_not_run: string | null; reasons: string[] };
    code: { level: string; destinations: { kind: string; value: string; on_file: boolean; why: string | null }[] };
  };
}
type Device = { p_scam: number; level: string; tactics: Record<string, number> };

const WORDS: Record<string, string> = {
  impersonation: "claims to be an authority, a bank or your boss", urgency_secrecy: "pushes you to act fast or keep it quiet", changed_details: "asks you to pay to new bank or PayPal details",
  off_platform: "asks to pay outside PayPal or move the chat elsewhere", gift_cards_crypto: "asks for gift cards or crypto", fee_to_release: "asks for a fee to release money or goods",
  otp_or_link: "asks for a code or sends a link to click", overpay_refund: "says they overpaid and wants the difference back", too_good: "promises a prize or guaranteed profit",
};
export const PAY_SOMEWHERE = "This asks you to pay somewhere. Confirm it by phone on a number you already had.";

/** The fine-tuned text model, run in this browser (onnxruntime-web, int8, 23 MB, downloaded once and cached). */
let guardP: Promise<{ score: (t: string) => Promise<Device> }> | null = null;
const MODEL_URL = "/static/safety/model/model_quantized.onnx";
/** Download the model once with progress; the loader then reads it from the browser's cache (the file is cached a day). */
async function prefetch(onProgress?: (k: number) => void) {
  const r = await fetch(MODEL_URL);
  const total = Number(r.headers.get("content-length") ?? 0);
  if (!r.body || !total || !onProgress) return void (await r.arrayBuffer());
  const rd = r.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    got += value.length;
    onProgress(Math.min(1, got / total));
  }
}
export function loadDeviceModel(onProgress?: (k: number) => void) {
  if (guardP) return guardP;
  guardP = Promise.all([prefetch(onProgress).catch(() => undefined), new Promise<void>((ok, bad) => {
    if ((window as any).ort) return ok();
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.22.0/ort.min.js";
    s.onload = () => ok();
    s.onerror = () => bad(new Error("The model runtime didn't load."));
    document.head.appendChild(s);
  })]).then(async () => {
    const ort = (window as any).ort;
    ort.env.wasm.wasmPaths = "https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.22.0/";
    const url = "/static/safety/guard-client.js";
    const mod = await import(/* @vite-ignore */ url);
    return mod.loadGuard({ modelUrl: MODEL_URL, tokenizerUrl: "/static/safety/model/tokenizer.json", headsUrl: "/static/safety/model/heads.json", ort });
  });
  guardP.catch(() => (guardP = null));
  return guardP;
}

/** Places to pay, found in this browser (the landing page's check sends nothing to a server). */
const PAY_WORDS = /\b(pay|paid|payment|send|transfer|deposit|invoice|remit|paypal|bank|account|refund|balance|fee)\b/i;
export function localDestinations(text: string): string[] {
  const found = [
    ...text.matchAll(/\b(?:https?:\/\/)?(?:www\.)?paypal\.me\/[\w.-]+/gi),
    ...[...text.matchAll(/(?<![\w.])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].filter((m) => PAY_WORDS.test(text.slice(Math.max(0, (m.index ?? 0) - 90), (m.index ?? 0) + m[0].length + 90))),
    ...text.matchAll(/\b(?:account|acct|bsb|iban)\b[^\d\n]{0,20}(?:\d[ -]?){6,20}\d/gi),
  ].map((m) => m[0]);
  return [...new Set(found)];
}

type Verdict = { lamp: LampState; title: string; body: string };
function verdictOf(server: ServerScan | null, serverErr: string | null, device: Device | null, deviceOnly: boolean, localDest: string[]): Verdict {
  const deviceTactic = device ? Object.values(device.tactics).some((p) => p >= 0.5) : false;
  const deviceLevel = !device ? null : device.level === "hold" ? "hold" : device.level === "caution" && deviceTactic ? "caution" : "clear";
  const levels = [server?.level, deviceLevel];
  const names = server?.names_destination || localDest.length > 0;
  if (levels.includes("hold")) return { lamp: "off", title: "Hold: don't pay or reply yet", body: "Pay only to details you confirmed by phone on a number you already had. Never share codes." };
  if (levels.includes("caution") || names) return { lamp: "hold", title: names ? "Check before you pay" : "Caution: check before you act", body: names ? PAY_SOMEWHERE : "Something here is worth a second look before you act." };
  const allRan = deviceOnly ? false : Boolean(server?.all_clear_allowed && device);
  if (allRan) return { lamp: "done", title: "No scam signs found", body: "Every check ran and none found a sign of a scam. A clear result is not a guarantee." };
  const missing = [!device && "the check on this device", !deviceOnly && (serverErr ? "the server checks" : server && !server.all_clear_allowed && server.readers.decisions.why_not_run ? `the AI check (${server.readers.decisions.why_not_run})` : null)].filter(Boolean);
  return { lamp: "idle", title: deviceOnly ? "No signs found on this device" : "Not fully checked", body: deviceOnly ? "That's one of three checks. Inside the app, the AI check and the comparison with the business's record run too, so this alone is not an all-clear." : `Nothing was found, but ${missing.join(" and ") || "one check"} didn't run, so this is not an all-clear.` };
}

export function ScamCheck({ endpoint, demo, deviceOnly = false, label = "Paste an email, text or chat message", note, tour }: { endpoint?: string; demo?: string | null; deviceOnly?: boolean; label?: string; note?: string; tour?: string }) {
  const [text, setText] = useState(() => (endpoint === "/safety/scan" ? new URLSearchParams(window.location.search).get("text")?.slice(0, 4000) ?? "" : "")); // /judge prefills it
  const [status, setStatus] = useState("");
  const [prog, setProg] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ server: ServerScan | null; serverErr: string | null; device: Device | null; deviceErr: string | null; ms: number; local: string[] } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const id = `scan-${endpoint ? endpoint.replace(/\W/g, "") : "device"}`;
  const check = async () => {
    const t = text.trim();
    if (!t) return area.current?.focus();
    setBusy(true);
    setRes(null);
    let server: ServerScan | null = null;
    let serverErr: string | null = null;
    let device: Device | null = null;
    let deviceErr: string | null = null;
    let ms = 0;
    const serverP = !deviceOnly && endpoint ? postJson<ServerScan>(endpoint, { text: t }).then((s) => (server = s), (e) => (serverErr = (e as Error).message)) : Promise.resolve();
    try {
      setStatus(guardP ? "Checking on this device…" : "Loading the scam model into this browser (23 MB, once)…");
      const g = await loadDeviceModel((k) => setProg(k));
      setProg(null);
      const t0 = performance.now();
      device = await g.score(t);
      ms = performance.now() - t0;
    } catch (e) {
      deviceErr = (e as Error).message;
    }
    if (!deviceOnly) setStatus("Waiting for the server checks…");
    await serverP;
    setRes({ server, serverErr, device, deviceErr, ms, local: deviceOnly ? localDestinations(t) : [] });
    setStatus("");
    setBusy(false);
  };
  const v = res ? verdictOf(res.server, res.serverErr, res.device, deviceOnly, res.local) : null;
  const tactics = res ? new Set([...(res.server?.tactics ?? []), ...Object.entries(res.device?.tactics ?? {}).filter(([, p]) => p >= 0.5).map(([k]) => k)]) : new Set<string>();
  const reasons = res?.server?.reasons ?? [];
  const dec = res?.server?.readers.decisions;
  const dests = res?.server?.readers.code.destinations ?? [];
  return (
    <Panel className="p-4" data-tour={tour}>
      <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); void check(); }}>
        <Label htmlFor={id}>{label}</Label>
        <Textarea id={id} ref={area} rows={4} value={text} onChange={(e) => setText(e.target.value)} className="text-base md:text-sm" placeholder="Paste the message here" />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy} aria-busy={busy}>{busy ? <Loader2 className="animate-spin" /> : <ScanSearch />}Check this message</Button>
          {demo ? <Button type="button" variant="outline" onClick={() => setText(demo)}>Paste the demo scam</Button> : null}
          <span role="status" className="text-sm text-ink-2">{status}</span>
        </div>
        {prog !== null && prog < 1 ? <progress className="h-2 w-full accent-[var(--brand)]" max={1} value={prog} aria-label="Downloading the scam model">{Math.round(prog * 100)}%</progress> : null}
        {note ? <p className="text-xs text-ink-2">{note}</p> : null}
      </form>
      {res && v ? (
        <div className="mt-4 space-y-3 border-t border-line pt-4" aria-live="polite">
          <StateChip s={v.lamp}>{v.title}</StateChip>
          <p className="text-sm">{v.body}</p>
          <dl className={`grid gap-2 text-sm ${deviceOnly ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-2 sm:grid-cols-4"}`}>
            <div className="rounded-[8px] bg-paper p-2"><dt className="text-xs text-ink-2">On this device</dt><dd className="font-semibold num">{res.device ? `${Math.round(res.device.p_scam * 100)}%` : "not run"}</dd><dd className="text-xs text-ink-2">{res.device ? `checked here in ${res.ms.toFixed(0)} ms${deviceOnly ? "; nothing left your browser" : ""}` : res.deviceErr ?? ""}</dd></div>
            {deviceOnly ? (
              <div className="rounded-[8px] bg-paper p-2"><dt className="text-xs text-ink-2">Places to pay found</dt><dd className="font-semibold">{res.local.length || "none"}</dd><dd className="break-all text-xs text-ink-2">{res.local.join(", ")}</dd></div>
            ) : (
              <>
                <div className="rounded-[8px] bg-paper p-2"><dt className="text-xs text-ink-2">Rules</dt><dd className="font-semibold">{res.server?.readers.rules.level ?? "not run"}</dd><dd className="text-xs text-ink-2">{res.server ? `${res.server.readers.rules.reasons.length || "no"} reason${res.server.readers.rules.reasons.length === 1 ? "" : "s"}` : res.serverErr ?? ""}</dd></div>
                <div className="rounded-[8px] bg-paper p-2"><dt className="text-xs text-ink-2">AI check</dt><dd className="font-semibold">{dec ? (dec.level === "not_run" ? "not run" : dec.level) : "not run"}</dd><dd className="text-xs text-ink-2">{dec?.model ? `${dec.model}, ${dec.ms} ms` : dec?.why_not_run ?? ""}</dd></div>
                <div className="rounded-[8px] bg-paper p-2"><dt className="text-xs text-ink-2">Places to pay</dt><dd className="font-semibold">{res.server ? (dests.length ? `${dests.filter((d) => !d.on_file).length} not on file` : "none") : "not run"}</dd><dd className="break-all text-xs text-ink-2">{dests.map((d) => d.value).join(", ")}</dd></div>
              </>
            )}
          </dl>
          {tactics.size ? <div><h4 className="text-sm font-semibold">What this message does</h4><ul className="list-disc pl-5 text-sm">{[...tactics].map((k) => <li key={k}>{WORDS[k] ?? k}</li>)}</ul></div> : null}
          {reasons.length ? <div><h4 className="text-sm font-semibold">Why</h4><ul className="list-disc pl-5 text-sm">{reasons.slice(0, 6).map((r) => <li key={r}>{r}</li>)}</ul></div> : null}
        </div>
      ) : null}
    </Panel>
  );
}
