/**
 * The hands-free section of /accessibility and its summary on /proof (spec A9): what it does, where the camera
 * picture goes, a simulated-gaze demo, and numbers that are measured (the benchmark below runs the page's own
 * snapping and dwell code on synthetic gaze; the person's own accuracy comes from their calibration).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { LANGS, t, tk } from "@/i18n";
import { cn } from "@/lib/utils";
import { setHandsFreeActive } from "./confirm";
import { MEDIAPIPE_VERSION } from "./engine";
import { GAZE_FILTER, OneEuro2, SNAP, Snapper, benchmark, gauss, rng, type Pt } from "./math";
import { lastCalibration } from "./settings";

export const BENCH_NOISE = [20, 40, 60, 80, 120];
export function useBenchmark() {
  return useMemo(() => BENCH_NOISE.map((n) => ({ noise: n, ...benchmark({ noisePx: n, trials: 300, seed: 7 }) })), []);
}
const pct = (v: number) => `${Math.round(v * 100)}%`;

/* ------------------------------------------------------------ the simulated demo */

const CARDS = [
  { id: "a", who: "Priya N.", what: tk("Deposit, $40.00") },
  { id: "b", who: "Lena M.", what: tk("Invoice #1051, $250.00") },
  { id: "c", who: "Harbour Physio", what: tk("Invoice #2210, $1,200.00") },
];

function SimDemo() {
  const box = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pt, setPt] = useState<Pt | null>(null);
  const [held, setHeld] = useState<string | null>(null);
  const [prog, setProg] = useState(0);
  const [card, setCard] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    if (!playing) return;
    const el = box.current!;
    const r = rng(11);
    const f = new OneEuro2(GAZE_FILTER.minCutoff, GAZE_FILTER.beta);
    const snap = new Snapper<string>({ ...SNAP, radius: 80 });
    // The script: look at Priya's "Call now", the card opens, look at Confirm (twice as long), then the next row.
    const plan: { key: string; ms: number }[] = [{ key: "b", ms: 600 }, { key: "call-a", ms: 2000 }, { key: "confirm", ms: 3200 }, { key: "call-b", ms: 1800 }, { key: "cancel", ms: 2000 }];
    let i = 0, since = performance.now(), cur: string | null = null, p = 0, last = performance.now(), cardOpen: string | null = null, raf = 0;
    const center = (key: string) => {
      const e = el.querySelector<HTMLElement>(`[data-demo="${key}"]`);
      if (!e) return null;
      const a = e.getBoundingClientRect(), b = el.getBoundingClientRect();
      return { x: a.left - b.left + a.width / 2, y: a.top - b.top + a.height / 2 };
    };
    const rects = () => [...el.querySelectorAll<HTMLElement>("[data-demo]")].filter((e) => !cardOpen || e.closest("[data-demo-card]")).map((e) => {
      const a = e.getBoundingClientRect(), b = el.getBoundingClientRect();
      return { key: e.dataset.demo!, rect: { left: a.left - b.left, right: a.right - b.left, top: a.top - b.top, bottom: a.bottom - b.top } };
    });
    const tick = () => {
      const now = performance.now();
      const step = plan[i % plan.length];
      if (now - since > step.ms) { i++; since = now; if (i % plan.length === 0) { cardOpen = null; setCard(null); setDone(null); } }
      const c = center(plan[i % plan.length].key);
      if (c) {
        const raw = { x: c.x + gauss(r) * 28, y: c.y + gauss(r) * 28 };
        const fp = f.filter(raw, now);
        setPt(fp);
        const k = snap.step(fp, rects());
        if (k !== cur) { cur = k; p = 0; } else if (k) p += now - last;
        const need = k === "confirm" ? 1400 : 700;
        setHeld(k);
        setProg(Math.min(1, p / need));
        if (k && p >= need) {
          p = 0;
          snap.reset();
          if (k.startsWith("call-")) { cardOpen = k.slice(5); setCard(cardOpen); }
          else if (k === "confirm") { setDone(cardOpen); cardOpen = null; setCard(null); }
          else if (k === "cancel") { cardOpen = null; setCard(null); }
        }
      }
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  const who = (id: string | null) => CARDS.find((c) => c.id === id)?.who ?? "";
  return (
    <div className="rounded-[12px] border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{t("Simulated gaze demo")}</p>
        <button type="button" className="min-h-11 rounded-[8px] border border-line px-3 text-sm" onClick={() => setPlaying((v) => !v)} aria-pressed={playing}>
          {playing ? <Pause className="inline size-4" aria-hidden="true" /> : <Play className="inline size-4" aria-hidden="true" />} {playing ? t("Pause") : t("Play")}
        </button>
      </div>
      <p className="mt-1 text-xs text-ink-2">{t("A scripted gaze path with 28 px of random jitter moves through the page's own snapping and dwell code. No camera is used; nothing here is real.")}</p>
      <div ref={box} className="relative mt-3 grid gap-2 overflow-hidden rounded-[10px] border border-line bg-paper p-3" aria-hidden="true" data-hf-ignore>
        {CARDS.map((c) => (
          <div key={c.id} data-demo={c.id} className={cn("flex min-h-[52px] flex-wrap items-center justify-between gap-2 rounded-[8px] border border-line px-3 py-1", held === c.id && "outline outline-[3px] outline-brand")}>
            <span className="min-w-0 text-sm"><b>{c.who}</b> · {t(c.what)}{done === c.id ? ` · ${t("call started (demo)")}` : ""}</span>
            <span data-demo={`call-${c.id}`} className={cn("shrink-0 rounded-[8px] bg-ink px-3 py-2 text-xs font-medium text-paper", held === `call-${c.id}` && "outline outline-[3px] outline-brand outline-offset-2")}>{t("Call now")}</span>
          </div>
        ))}
        {card ? (
          <div data-demo-card className="absolute inset-x-6 top-6 rounded-[12px] border border-line bg-surface p-3 shadow-lg">
            <p className="text-sm font-semibold">{t("Check before it happens")}</p>
            <p className="text-xs">{t("This places a call to a customer: {0}. Confirm to go ahead.", [who(card)])}</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <span data-demo="cancel" className={cn("rounded-[8px] border border-line px-3 py-3 text-center text-sm", held === "cancel" && "outline outline-[3px] outline-brand")}>{t("Cancel")}</span>
              <span data-demo="confirm" className={cn("rounded-[8px] bg-ink px-3 py-3 text-center text-sm font-semibold text-paper", held === "confirm" && "outline outline-[3px] outline-brand")}>{t("Confirm")}</span>
            </div>
          </div>
        ) : null}
        {pt ? <span className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-paper bg-brand" style={{ left: pt.x, top: pt.y }} /> : null}
        {held && prog > 0 ? <span className="pointer-events-none absolute right-2 top-2 rounded bg-ink px-2 py-0.5 text-xs text-paper">{t("dwell {0}%", [Math.round(prog * 100)])}</span> : null}
      </div>
      <p className="sr-only" aria-live="polite">{done ? t("Demo: the call to {0} was confirmed.", [who(done)]) : card ? t("Demo: the confirm card is open.") : ""}</p>
    </div>
  );
}

/* ------------------------------------------------------------ the section */

const COMMANDS: { what: string; en: string; hi: string; id: string; pt: string }[] = [
  { what: tk("Stop hands-free"), en: "stop", hi: "रुको · ruko", id: "berhenti", pt: "pare · parar" },
  { what: tk("Press what you're looking at"), en: "this one · click", hi: "यह वाला · yeh wala", id: "yang ini · klik", pt: "este · esse aqui" },
  { what: tk("Open a page"), en: "open calls", hi: "कॉल्स खोलो", id: "buka panggilan", pt: "abrir ligações" },
  { what: tk("Answer the confirm card"), en: "confirm / cancel", hi: "हाँ / नहीं", id: "ya / batal", pt: "sim / cancelar" },
  { what: tk("Chain steps (up to 10)"), en: "… then …", hi: "… फिर …", id: "… lalu …", pt: "… depois …" },
  { what: tk("Anything else becomes a question for Ask"), en: "who owes money this week", hi: "इस हफ़्ते किसका पैसा बाकी है", id: "siapa yang masih berutang", pt: "quem deve esta semana" },
];

export function HandsFreeAbout() {
  const bench = useBenchmark();
  const cal = lastCalibration();
  return (
    <section id="hands-free" className="grid gap-3 scroll-mt-20">
      <h2 className="text-h2 font-semibold">{t("Hands-free: look and say")}</h2>
      <p className="text-sm">{t("For people who can't easily use a mouse or a touch screen. Point with your eyes (after a 9-dot calibration) or your head; the pointer snaps to the nearest button, and looking at it for about a second fills a ring and presses it. A wink can press too. Voice commands work in English, Hindi, Indonesian and Brazilian Portuguese. Start it from Display and help, or with Alt+Shift+H.")}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" data-risk="none" className="min-h-11 rounded-[8px] bg-ink px-4 text-sm font-medium text-paper" onClick={() => setHandsFreeActive(true)}>{t("Start hands-free here")}</button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-[12px] border border-line bg-surface p-3 text-sm">
          <h3 className="font-semibold">{t("Where the camera picture goes")}</h3>
          <p className="mt-1">{t("Nowhere. Google's MediaPipe Face Landmarker (version {0}) runs inside this browser tab and turns each frame into a few numbers (where the irises sit, how the head is turned, whether an eye is closed); the frame is then dropped. No picture is stored or sent. The runtime comes from Callback's own server; the 4 MB face model comes once from Google's MediaPipe model storage. A red dot and \"Camera on, on this device only\" show while the camera is open.", [MEDIAPIPE_VERSION])}</p>
          <p className="mt-2 text-ink-2">{t("Voice commands use your browser's own speech recognition; in Chrome that is Google's online service. Callback receives the words only.")}</p>
        </div>
        <div className="rounded-[12px] border border-line bg-surface p-3 text-sm">
          <h3 className="font-semibold">{t("What it won't do on its own")}</h3>
          <p className="mt-1">{t("Code, not a model, decides which presses stop at a confirm card: moving money, refunds, placing a call, deleting, cancelling, sending a message, disputes, approvals and resets. Confirm needs twice the usual look, or the word “confirm”. Before pressing, it reads the button: a disabled one is announced, not pressed; a switch says whether it is on. Links to PayPal stop with a note that hands-free can't work on PayPal's own pages.")}</p>
          <p className="mt-2 text-ink-2">{t("It gives way: moving your own mouse hands control back for 2.5 seconds; a blink freezes the pointer; looking away for 2 seconds pauses; Esc or “stop” turns it off. With no camera, or offline before the model has loaded, it falls back to keyboard scan (the highlight steps through the buttons; Space presses).")}</p>
        </div>
      </div>
      <SimDemo />
      <figure className="grid gap-1">
        <video className="w-full rounded-[10px] border border-line" src="/media/handsfree-demo.webm" controls muted playsInline preload="metadata" aria-describedby="hf-video-cap">
          <track kind="captions" src="/media/handsfree-demo.vtt" srcLang="en" label={t("English descriptions")} default />
        </video>
        <figcaption id="hf-video-cap" className="text-xs text-ink-2">{t("A 30-second recording of hands-free in Callback, driven by simulated gaze in a headless browser (not a person's eyes): it snaps to a call, the confirm card stops the call until Confirm is held, a plain link opens with no card, and “stop” turns it off. No sound.")}</figcaption>
      </figure>
      <div className="grid gap-2">
        <h3 className="font-semibold">{t("How well it picks the right button (measured)")}</h3>
        <p className="text-sm text-ink-2">{t("Simulated benchmark, computed now in this page with the page's own code: 300 looks at random buttons among 48 (120 × 44 px, on 1280 × 800), gaze jitter as shown, 0.7 s dwell. This tests snapping and dwell, not a camera or real eyes.")}</p>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={t("Benchmark results")}>
          <table className="w-full min-w-[420px] text-sm">
            <thead><tr className="text-left text-ink-2"><th className="py-1 pr-3 font-medium">{t("Gaze jitter")}</th><th className="py-1 pr-3 font-medium">{t("Right button")}</th><th className="py-1 pr-3 font-medium">{t("Wrong button")}</th><th className="py-1 pr-3 font-medium">{t("Nothing pressed")}</th><th className="py-1 font-medium">{t("Mean time")}</th></tr></thead>
            <tbody>
              {bench.map((b) => (
                <tr key={b.noise} className="border-t border-line" data-bench={b.noise}>
                  <td className="py-1 pr-3 num">{t("{0} px", [b.noise])}</td>
                  <td className="py-1 pr-3 num">{pct(b.accuracy)}</td>
                  <td className="py-1 pr-3 num">{pct(b.wrongRate)}</td>
                  <td className="py-1 pr-3 num">{pct(b.none / b.trials)}</td>
                  <td className="py-1 num">{t("{0} s", [b.meanSeconds.toFixed(1)])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm">{cal ? t("Your device: the last calibration here landed about {0} px from the dots on average ({1} px at the worst), checked by leaving each dot out of the fit.", [cal.meanPx, cal.worstPx]) : t("Your device: not calibrated yet. Start hands-free with eyes to measure it; the number appears here.")}</p>
        <p className="text-sm text-ink-2">{t("Not measured: accuracy with real people's eyes. Webcam gaze is usually far looser than the low rows above; if your calibration says more than about 120 px, the head pointer or keyboard scan will be easier.")}</p>
      </div>
      <div className="grid gap-2">
        <h3 className="font-semibold">{t("Voice commands")}</h3>
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={t("Voice commands in four languages")}>
          <table className="w-full min-w-[560px] text-sm">
            <thead><tr className="text-left text-ink-2"><th className="py-1 pr-3 font-medium">{t("To")}</th>{LANGS.map((l) => <th key={l.code} className="py-1 pr-3 font-medium" lang={l.code}>{l.name}</th>)}</tr></thead>
            <tbody>
              {COMMANDS.map((c) => (
                <tr key={c.what} className="border-t border-line align-top">
                  <td className="py-1 pr-3">{t(c.what)}</td>
                  <td className="py-1 pr-3" lang="en">{c.en}</td>
                  <td className="py-1 pr-3" lang="hi-IN">{c.hi}</td>
                  <td className="py-1 pr-3" lang="id-ID">{c.id}</td>
                  <td className="py-1" lang="pt-BR">{c.pt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-ink-2">{t("“Stop” in any of the four languages works whatever the page language is, with or without the wake word. Commands need “Callback” first, or a press of Talk, depending on the setting. Keys: Alt+Shift+H on or off, Alt+Shift+C calibrate (or re-centre the head pointer), Alt+Shift+V talk, Alt+Shift+D debug panel, Esc stop.")}</p>
      </div>
    </section>
  );
}

/** The short version for /proof. */
export function HandsFreeProof() {
  const bench = useBenchmark();
  const at = (n: number) => bench.find((b) => b.noise === n)!;
  return (
    <div className="rounded-[12px] border border-line bg-surface p-4 text-sm" data-testid="hf-proof">
      <h3 className="font-semibold">{t("Hands-free (look and say)")}</h3>
      <p className="mt-1">{t("Simulated benchmark, run now in this page: right button {0} at 40 px gaze jitter, {1} at 80 px, {2} at 120 px; wrong button at most {3}. At heavy jitter it mostly presses nothing rather than the wrong thing.", [pct(at(40).accuracy), pct(at(80).accuracy), pct(at(120).accuracy), pct(Math.max(...bench.map((b) => b.wrongRate)))])}</p>
      <p className="mt-1 text-ink-2">{t("End-to-end tests drive the real controller with simulated gaze (confirm card, double dwell, Hindi “stop”) and load MediaPipe on a fake camera. Not tested with a person's real eyes.")}{" "}<a className="underline" href="/accessibility#hands-free">{t("Details")}</a></p>
    </div>
  );
}
