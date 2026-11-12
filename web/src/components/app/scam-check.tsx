import { useRef, useState } from "react";
import { Loader2, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Panel, StateChip } from "@/components/app/bits";
import { postJson } from "@/lib/api";
import type { LampState } from "@/lib/format";

import { t, tk, tmap } from "@/i18n";
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

const WORDS: Record<string, string> = tmap({
  impersonation: "claims to be an authority, a bank or your boss", urgency_secrecy: "pushes you to act fast or keep it quiet", changed_details: "asks you to pay to new bank or PayPal details",
  off_platform: "asks to pay outside PayPal or move the chat elsewhere", gift_cards_crypto: "asks for gift cards or crypto", fee_to_release: "asks for a fee to release money or goods",
  otp_or_link: "asks for a code or sends a link to click", overpay_refund: "says they overpaid and wants the difference back", too_good: "promises a prize or guaranteed profit",
});
export const PAY_SOMEWHERE = tk("This asks you to pay somewhere. Confirm it by phone on a number you already had.");

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
    s.onerror = () => bad(new Error(t("The model runtime didn't load.")));
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
  if (levels.includes("hold")) return { lamp: "off", title: t("Hold: don't pay or reply yet"), body: t("Pay only to details you confirmed by phone on a number you already had. Never share codes.") };
  if (levels.includes("caution") || names) return { lamp: "hold", title: names ? t("Check before you pay") : t("Caution: check before you act"), body: names ? t(PAY_SOMEWHERE) : t("Something here is worth a second look before you act.") };
  const allRan = deviceOnly ? false : Boolean(server?.all_clear_allowed && device);
  if (allRan) return { lamp: "done", title: t("No scam signs found"), body: t("Every check ran and none found a sign of a scam. A clear result is not a guarantee.") };
  const missing = [!device && t("the check on this device"), !deviceOnly && (serverErr ? t("the server checks") : server && !server.all_clear_allowed && server.readers.decisions.why_not_run ? t("the AI check ({0})", [server.readers.decisions.why_not_run]) : null)].filter(Boolean);
  return { lamp: "idle", title: deviceOnly ? t("No signs found on this device") : t("Not fully checked"), body: deviceOnly ? t("That's one of three checks. Inside the app, the AI check and the comparison with the business's record run too, so this alone is not an all-clear.") : t("Nothing was found, but {0} didn't run, so this is not an all-clear.", [missing.join(t(" and ")) || t("one check")]) };
}

export function ScamCheck({ endpoint, demo, deviceOnly = false, label = tk("Paste an email, text or chat message"), note, tour }: { endpoint?: string; demo?: string | null; deviceOnly?: boolean; label?: string; note?: string; tour?: string }) {
  const [text, setText] = useState(() => (endpoint === "/safety/scan" ? new URLSearchParams(window.location.search).get("text")?.slice(0, 4000) ?? "" : "")); // /judge prefills it
  const [status, setStatus] = useState("");
  const [prog, setProg] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ server: ServerScan | null; serverErr: string | null; device: Device | null; deviceErr: string | null; ms: number; local: string[] } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const id = `scan-${endpoint ? endpoint.replace(/\W/g, "") : "device"}`;
  const check = async () => {
    const txt = text.trim();
    if (!txt) return area.current?.focus();
    setBusy(true);
    setRes(null);
    let server: ServerScan | null = null;
    let serverErr: string | null = null;
    let device: Device | null = null;
    let deviceErr: string | null = null;
    let ms = 0;
    const serverP = !deviceOnly && endpoint ? postJson<ServerScan>(endpoint, { text: txt }).then((s) => (server = s), (e) => (serverErr = (e as Error).message)) : Promise.resolve();
    try {
      setStatus(guardP ? t("Checking on this device…") : t("Loading the scam model into this browser (23 MB, once)…"));
      const g = await loadDeviceModel((k) => setProg(k));
      setProg(null);
      const t0 = performance.now();
      device = await g.score(txt);
      ms = performance.now() - t0;
    } catch (e) {
      deviceErr = (e as Error).message;
    }
    if (!deviceOnly) setStatus(t("Waiting for the server checks…"));
    await serverP;
    setRes({ server, serverErr, device, deviceErr, ms, local: deviceOnly ? localDestinations(txt) : [] });
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
        <Label htmlFor={id}>{t(label)}</Label>
        <Textarea id={id} ref={area} rows={4} value={text} onChange={(e) => setText(e.target.value)} className="text-base md:text-sm" placeholder={t("Paste the message here")} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy} aria-busy={busy}>{busy ? <Loader2 className="animate-spin" /> : <ScanSearch />}{t("Check this message")}</Button>
          {demo ? <Button type="button" variant="outline" onClick={() => setText(demo)}>{t("Paste the demo scam")}</Button> : null}
          <span role="status" className="text-sm text-ink-2">{status}</span>
        </div>
        {prog !== null && prog < 1 ? <progress className="h-2 w-full accent-[var(--brand)]" max={1} value={prog} aria-label={t("Downloading the scam model")}>{Math.round(prog * 100)}%</progress> : null}
        {note ? <p className="text-xs text-ink-2">{note}</p> : null}
      </form>
      {res && v ? (
        <div className="mt-4 space-y-3 border-t border-line pt-4" aria-live="polite">
          <StateChip s={v.lamp}>{v.title}</StateChip>
          <p className="text-sm">{v.body}</p>
          <dl className={`grid gap-2 text-sm ${deviceOnly ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-2 sm:grid-cols-4"}`}>
            <div className="rounded-[8px] bg-paper p-2"><dt className="text-xs text-ink-2">{t("On this device")}</dt><dd className="font-semibold num">{res.device ? `${Math.round(res.device.p_scam * 100)}%` : t("not run")}</dd><dd className="text-xs text-ink-2">{res.device ? t("checked here in {0} ms{1}", [res.ms.toFixed(0), deviceOnly ? "; nothing left your browser" : ""]) : res.deviceErr ?? ""}</dd></div>
            {deviceOnly ? (
              <div className="rounded-[8px] bg-paper p-2"><dt className="text-xs text-ink-2">{t("Places to pay found")}</dt><dd className="font-semibold">{res.local.length || t("none")}</dd><dd className="break-all text-xs text-ink-2">{res.local.join(", ")}</dd></div>
            ) : (
              <>
                <div className="rounded-[8px] bg-paper p-2"><dt className="text-xs text-ink-2">{t("Rules")}</dt><dd className="font-semibold">{res.server?.readers.rules.level ?? t("not run")}</dd><dd className="text-xs text-ink-2">{res.server ? t("{0} reason{1}", [res.server.readers.rules.reasons.length || "no", res.server.readers.rules.reasons.length === 1 ? "" : "s"]) : res.serverErr ?? ""}</dd></div>
                <div className="rounded-[8px] bg-paper p-2"><dt className="text-xs text-ink-2">{t("AI check")}</dt><dd className="font-semibold">{dec ? (dec.level === "not_run" ? t("not run") : dec.level) : t("not run")}</dd><dd className="text-xs text-ink-2">{dec?.model ? t("{0}, {1} ms", [dec.model, dec.ms]) : dec?.why_not_run ?? ""}</dd></div>
                <div className="rounded-[8px] bg-paper p-2"><dt className="text-xs text-ink-2">{t("Places to pay")}</dt><dd className="font-semibold">{res.server ? (dests.length ? t("{0} not on file", [dests.filter((d) => !d.on_file).length]) : t("none")) : t("not run")}</dd><dd className="break-all text-xs text-ink-2">{dests.map((d) => d.value).join(", ")}</dd></div>
              </>
            )}
          </dl>
          {tactics.size ? <div><h4 className="text-sm font-semibold">{t("What this message does")}</h4><ul className="list-disc pl-5 text-sm">{[...tactics].map((k) => <li key={k}>{WORDS[k] ?? k}</li>)}</ul></div> : null}
          {reasons.length ? <div><h4 className="text-sm font-semibold">{t("Why")}</h4><ul className="list-disc pl-5 text-sm">{reasons.slice(0, 6).map((r) => <li key={r}>{r}</li>)}</ul></div> : null}
        </div>
      ) : null}
    </Panel>
  );
}
