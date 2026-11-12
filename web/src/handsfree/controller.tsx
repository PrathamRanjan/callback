/**
 * Hands-free "Look and Say" (spec A): the part that loads only when someone turns it on.
 *
 * Gaze (calibrated) or head (no calibration) moves a pointer; the pointer snaps to the nearest button by decaying
 * votes; holding the look fills a ring and presses ("dwell"). A wink or the word "click" presses at once. Voice
 * commands run through the same press path. Every press goes through activate(), which reads the button's state
 * first and stops at the confirm card for money, refunds, calls, deletes, cancels, sends, disputes and approvals.
 *
 * It gives way: a real mouse move hands control back for 2.5 s, a blink freezes the pointer, looking away for 2 s
 * pauses it, Esc or "stop" (in any of the four languages) turns it off.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Camera, Crosshair, Mic, Square, Bug, Eye, Move, Keyboard } from "lucide-react";
import { currentLang, langInfo, t } from "@/i18n";
import { answer, askCard, markConfirmed, useConfirmReq } from "./confirm";
import { Drift, GAZE_FILTER, OneEuro2, Snapper, TOPUP, crossValidate, fitRidge, headPoint, headShifted, nineDots, predict, type Pt, type Sample } from "./math";
import { HandsFreeError, startCamera, type Camera as Cam, type Frame } from "./engine";
import { loadCalibration, saveCalibration, setHf, useHf, type Calibration, type HfMode } from "./settings";
import { isStop, parseCommand, riskOf, type HfLang, type Risk, type Step } from "./words";
import { speak, startVoice, voiceSupported, type Heard, type VoiceCtl } from "./voice";

const SEL = 'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="radio"], [role="checkbox"], [role="switch"], [role="option"], input:not([type="hidden"]), select, textarea, summary, [data-hf-target]';

function visible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
  if (el.closest("[data-hf-ignore], [aria-hidden='true'], [inert]")) return false;
  const s = getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
}
function scope(): ParentNode {
  const card = document.querySelector("[data-hf-card]");
  if (card) return card;
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"], [role="alertdialog"], [role="menu"]')].filter(visible);
  return dialogs[dialogs.length - 1] ?? document;
}
export function collectTargets(): HTMLElement[] {
  return [...scope().querySelectorAll<HTMLElement>(SEL)].filter(visible);
}
export function nameOf(el: HTMLElement): string {
  const label = el.getAttribute("aria-label") || (el.id && document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`)?.textContent) || el.textContent || el.getAttribute("title") || (el as HTMLInputElement).placeholder || "";
  return label.replace(/\s+/g, " ").trim().slice(0, 80) || t("Unnamed control");
}
const isDisabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true" || Boolean(el.closest("fieldset[disabled]"));
const isTextField = (el: HTMLElement) => el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes((el as HTMLInputElement).type)) || el.isContentEditable;
function stateOf(el: HTMLElement): string | null {
  const name = nameOf(el);
  const pressed = el.getAttribute("aria-pressed") ?? el.getAttribute("aria-checked") ?? ((el as HTMLInputElement).type === "checkbox" || (el as HTMLInputElement).type === "radio" ? String((el as HTMLInputElement).checked) : null);
  if (pressed === "true") return t("{0} is on now.", [name]);
  if (pressed === "false") return t("{0} is off now.", [name]);
  const exp = el.getAttribute("aria-expanded");
  if (exp === "true") return t("{0} is open now.", [name]);
  if (exp === "false") return t("{0} is closed now.", [name]);
  return null;
}
function riskText(r: Risk, name: string): string {
  switch (r) {
    case "payment": return t("This moves money: {0}. Confirm to go ahead.", [name]);
    case "refund": return t("This refunds money: {0}. Confirm to go ahead.", [name]);
    case "call": return t("This places a call to a customer: {0}. Confirm to go ahead.", [name]);
    case "delete": return t("This deletes something: {0}. Confirm to go ahead.", [name]);
    case "cancel": return t("This cancels or stops something: {0}. Confirm to go ahead.", [name]);
    case "send": return t("This sends a message: {0}. Confirm to go ahead.", [name]);
    case "dispute": return t("This is about a dispute: {0}. Confirm to go ahead.", [name]);
    case "approve": return t("This approves or changes what Callback may do: {0}. Confirm to go ahead.", [name]);
    case "reset": return t("This resets something: {0}. Confirm to go ahead.", [name]);
    case "handover": return t("PayPal's own page opens next. Hands-free can't see or press anything there: finish on PayPal with your mouse, keyboard or your device's own accessibility tools, then come back.");
  }
}

function pageName(to: string): string {
  const m: Record<string, string> = { "/today": t("Today"), "/calls": t("Calls"), "/customers": t("Customers"), "/approvals": t("Approvals"), "/money": t("Money"), "/rules": t("Rules"), "/safety": t("Safety"), "/messages": t("Messages"), "/ask": t("Ask"), "/accessibility": t("Accessibility") };
  return m[to] ?? to;
}

type Status = "starting" | "calibrating" | "on" | "paused-mouse" | "paused-away" | "error";
interface Dbg { fps: number; face: boolean; yaw: number; blinkL: number; blinkR: number; pt: Pt | null; target: string; vote: number; acc: number | null; drift: Pt; heard: Heard | null; voice: string; source: string }

/** Where test and demo gaze comes from: window.__cbHfSim = {x, y} (or null for "no face"). */
const simOn = () => new URLSearchParams(location.search).get("hf") === "sim" || "__cbHfSim" in window;

export default function Controller({ onOff }: { onOff: () => void }) {
  const s = useHf();
  const nav = useNavigate();
  const req = useConfirmReq();
  const lang = (currentLang() === "pseudo" ? "en" : currentLang()) as HfLang;
  const [status, setStatus] = useState<Status>("starting");
  const [notice, setNotice] = useState<string>("");
  const [live, setLive] = useState("");
  const [cal, setCal] = useState<Calibration | null>(() => loadCalibration());
  const [calib, setCalib] = useState<null | { dots: number[]; i: number; result?: { meanPx: number; worstPx: number } }>(null);
  const [moved, setMoved] = useState(false);
  const [dbg, setDbg] = useState<Dbg | null>(null);
  const [voiceState, setVoiceState] = useState<string>("off");
  const [source, setSource] = useState<"camera" | "sim" | "scan">(s.mode === "scan" ? "scan" : simOn() ? "sim" : "camera");

  const pointer = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const ring = useRef<SVGCircleElement>(null);
  const chip = useRef<HTMLSpanElement>(null);

  const mode = useRef<HfMode>(s.mode);
  mode.current = source === "scan" ? "scan" : s.mode;
  const sRef = useRef(s);
  sRef.current = s;

  const st = useRef({
    frame: null as Frame | null, pt: null as Pt | null, raw: null as Pt | null, held: null as HTMLElement | null, last: null as { el: HTMLElement; at: number } | null,
    progress: 0, lastT: 0, cooldown: 0, pausedUntil: 0, awaySince: 0, frozen: false, targets: [] as HTMLElement[], targetsAt: 0,
    snapper: new Snapper<HTMLElement>(), filter: new OneEuro2(GAZE_FILTER.minCutoff, GAZE_FILTER.beta), drift: new Drift(), noseRef: null as Pt | null,
    samples: [] as Sample[], calDot: -1, calFrom: 0, winkSince: 0, winkEye: "" as "" | "L" | "R", fpsN: 0, fpsAt: 0, fps: 0, scanI: -1, scanAt: 0,
    heard: null as Heard | null, busy: false, lastShiftCheck: 0,
  });
  const cam = useRef<Cam | null>(null);
  const voice = useRef<VoiceCtl | null>(null);

  const say = useCallback((m: string) => {
    setLive(m);
    if (sRef.current.speakBack && sRef.current.voice !== "off") speak(m, langInfo().speech);
  }, []);

  /* ------------------------------------------------------------ pressing */
  const activate = useCallback(async (el: HTMLElement | null) => {
    const x = st.current;
    if (!el) return;
    // The card's own buttons answer it (the press that opened it is still waiting on it, so check them first).
    if (el.closest("[data-hf-card]")) { el.click(); return; }
    if (x.busy) return;
    const name = nameOf(el);
    if (isDisabled(el)) { say(t("{0} is not available right now.", [name])); return; }
    if (isTextField(el)) { el.focus(); say(t("{0}: ready for typing. Use the keyboard, or the microphone button beside it.", [name])); return; }
    const before = stateOf(el);
    const risk = riskOf({ risk: el.dataset.risk, path: el.dataset.act ?? el.closest("form")?.getAttribute("action"), href: el instanceof HTMLAnchorElement ? el.href : null, text: name });
    if (risk) {
      x.busy = true;
      const ok = await askCard(el.dataset.confirm || riskText(risk, name), risk, name);
      x.busy = false;
      if (!ok) { say(t("Not done: {0}.", [name])); return; }
      markConfirmed(el);
    }
    if (before) say(before);
    el.focus({ preventScroll: true });
    el.click();
    if (!before) say(t("Pressed: {0}.", [name]));
  }, [say]);

  /* ------------------------------------------------------------ voice commands */
  const run = useCallback(async (steps: Step[], dropped: number) => {
    for (const step of steps) {
      const x = st.current;
      const target = x.held ?? (x.last && Date.now() - x.last.at < 2500 ? x.last.el : null);
      switch (step.kind) {
        case "press": if (target) await activate(target); else say(t("Look at a button first, then say it again.")); break;
        case "confirm": if (document.querySelector("[data-hf-card]")) answer(true); break;
        case "cancel": if (document.querySelector("[data-hf-card]")) answer(false); break;
        case "go": nav(step.to); say(t("Opening {0}.", [pageName(step.to)])); break;
        case "back": history.back(); break;
        case "scroll": scrollBy({ top: (step.dir === "down" ? 1 : -1) * innerHeight * 0.6, behavior: "smooth" }); break;
        case "next": case "prev": {
          const ts = collectTargets();
          const i = target ? ts.indexOf(target) : -1;
          const n = ts[(i + (step.kind === "next" ? 1 : -1) + ts.length) % ts.length];
          if (n) { x.scanI = ts.indexOf(n); x.held = n; x.last = { el: n, at: Date.now() }; n.scrollIntoView({ block: "nearest" }); say(nameOf(n)); }
          break;
        }
        case "calibrate": startCalibration(); break;
        case "ask": nav(`/ask?q=${encodeURIComponent(step.q.slice(0, 400))}`); say(t("Opening Ask with your question. Check it, then press Ask.")); break;
      }
      await new Promise((r) => setTimeout(r, 350));
    }
    if (dropped) say(t("I did the first 10 steps and stopped; say the rest again."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activate, nav, say]);
  const command = useCallback((text: string) => {
    const { steps, dropped } = parseCommand(text, lang);
    void run(steps, dropped);
  }, [lang, run]);

  /* ------------------------------------------------------------ calibration */
  const startCalibration = useCallback((topUp = false) => {
    if (mode.current !== "gaze") return;
    // A top-up re-takes three dots and keeps this session's other six; with no other six in memory, do all nine.
    const keep = st.current.samples.filter((x) => !TOPUP.includes(x.dot ?? -1));
    if (topUp && new Set(keep.map((x) => x.dot)).size < 6) topUp = false;
    st.current.samples = topUp ? keep : [];
    setMoved(false);
    setCalib({ dots: topUp ? TOPUP : [0, 1, 2, 3, 4, 5, 6, 7, 8], i: 0 });
    setStatus("calibrating");
  }, [cal]);

  useEffect(() => {
    if (!calib || calib.result) return;
    const x = st.current;
    const dot = calib.dots[calib.i];
    if (dot === undefined) {
      // All dots done: fit, then check the fit by leaving each dot out.
      try {
        const samples = x.samples;
        const model = fitRidge(samples, 0.02, 2);
        const cv = crossValidate(samples, 0.02, 2);
        const head = x.frame?.head ?? { cx: 0.5, cy: 0.5, scale: 0.1 };
        const c: Calibration = { model, meanPx: Math.round(cv.meanPx), worstPx: Math.round(cv.worstPx), at: new Date().toISOString(), screen: { w: innerWidth, h: innerHeight }, head, dots: new Set(samples.map((q) => q.dot)).size, samples: samples.length };
        saveCalibration(c);
        setCal(c);
        x.drift.reset();
        x.filter.reset();
        setCalib({ ...calib, result: { meanPx: c.meanPx, worstPx: c.worstPx } });
      } catch {
        setNotice(t("Calibration didn't get enough looks at the dots. Keep your face in view and try again."));
        setCalib(null);
        setStatus("on");
      }
      return;
    }
    x.calDot = -1;
    const settle = setTimeout(() => { x.calDot = dot; x.calFrom = performance.now(); }, 650);
    const next = setTimeout(() => { x.calDot = -1; setCalib((c) => (c && !c.result ? { ...c, i: c.i + 1 } : c)); }, 1650);
    return () => { clearTimeout(settle); clearTimeout(next); };
  }, [calib]);

  /* ------------------------------------------------------------ the per-frame step */
  const stepFrame = useCallback((pt: Pt | null, t0: number) => {
    const x = st.current;
    const dt = x.lastT ? Math.min(100, t0 - x.lastT) : 33;
    x.lastT = t0;
    x.fpsN++;
    if (t0 - x.fpsAt > 1000) { x.fps = x.fpsN; x.fpsN = 0; x.fpsAt = t0; }
    const hide = () => {
      if (pointer.current) pointer.current.style.opacity = "0";
      if (box.current) box.current.style.opacity = "0";
    };
    if (x.pausedUntil > t0) { hide(); return; }
    if (t0 - x.targetsAt > 300) { x.targets = collectTargets(); x.targetsAt = t0; }
    if (pt && pointer.current) {
      pointer.current.style.opacity = "1";
      pointer.current.style.transform = `translate(${pt.x - 8}px, ${pt.y - 8}px)`;
    }
    const cur = x.snapper.step(x.frozen ? null : pt, x.targets.map((el) => ({ key: el, rect: el.getBoundingClientRect() })));
    if (cur !== x.held) {
      x.held = cur;
      x.progress = 0;
      if (cur) { x.last = { el: cur, at: Date.now() }; setLive(nameOf(cur) + (isDisabled(cur) ? ` (${t("not available")})` : "")); }
    } else if (cur && !x.frozen && t0 > x.cooldown) x.progress += dt;
    if (cur) x.last = { el: cur, at: Date.now() };
    const need = sRef.current.dwellMs * (cur?.hasAttribute("data-hf-confirm") ? 2 : 1);
    if (box.current) {
      if (cur) {
        const r = cur.getBoundingClientRect();
        box.current.style.opacity = "1";
        box.current.style.transform = `translate(${r.left - 4}px, ${r.top - 4}px)`;
        box.current.style.width = `${r.width + 8}px`;
        box.current.style.height = `${r.height + 8}px`;
        if (chip.current) chip.current.textContent = nameOf(cur);
      } else box.current.style.opacity = "0";
    }
    if (ring.current) ring.current.style.strokeDashoffset = String(113 * (1 - Math.min(1, x.progress / need)));
    if (cur && x.progress >= need) {
      x.progress = 0;
      x.cooldown = t0 + 900;
      x.snapper.reset();
      void activate(cur);
    }
  }, [activate, source]);

  const onFrame = useCallback((f: Frame) => {
    const x = st.current;
    x.frame = f;
    const now = f.t;
    // Looking away (no face, or head turned far) for 2 s pauses; looking back resumes.
    if (!f.face || Math.abs(f.yawDeg) > 35) {
      if (!x.awaySince) x.awaySince = now;
      if (now - x.awaySince > 2000) { setStatus((v) => (v === "on" ? "paused-away" : v)); x.held = null; x.snapper.reset(); stepFrame(null, now); return; }
    } else if (x.awaySince) { x.awaySince = 0; setStatus((v) => (v === "paused-away" ? "on" : v)); }
    // Blink freeze: both eyes closed holds the pointer and the dwell where they are.
    x.frozen = f.blinkL > 0.55 && f.blinkR > 0.55;
    // Wink: one eye closed, the other open, for 0.2–0.9 s, presses the target.
    if (sRef.current.wink && !x.frozen) {
      const eye = f.blinkL > 0.6 && f.blinkR < 0.3 ? "L" : f.blinkR > 0.6 && f.blinkL < 0.3 ? "R" : "";
      if (eye && eye === x.winkEye) {
        if (now - x.winkSince > 200 && now - x.winkSince < 900 && x.held && now > x.cooldown) { x.cooldown = now + 1200; void activate(x.held); x.winkEye = ""; }
      } else { x.winkEye = eye; x.winkSince = now; }
    }
    // Calibration: collect samples while a dot is showing.
    if (x.calDot >= 0 && f.f && !x.frozen) {
      const d = nineDots(innerWidth, innerHeight)[x.calDot];
      x.samples.push({ f: f.f, target: d, dot: x.calDot });
      return;
    }
    if (mode.current === "head" && f.nose) {
      if (!x.noseRef) x.noseRef = f.nose;
      const p = x.filter.filter(headPoint(f.nose, x.noseRef, innerWidth, innerHeight), now);
      x.raw = p;
      x.pt = p;
      stepFrame(p, now);
      return;
    }
    if (mode.current === "gaze" && f.f && cal && !x.frozen) {
      const raw = predict(cal.model, f.f);
      x.raw = raw;
      const p = x.filter.filter(x.drift.apply(raw), now);
      x.pt = { x: Math.min(innerWidth, Math.max(0, p.x)), y: Math.min(innerHeight, Math.max(0, p.y)) };
      if (f.head && now - x.lastShiftCheck > 1000) { x.lastShiftCheck = now; if (headShifted(f.head, cal.head)) setMoved(true); }
    }
    stepFrame(x.pt, now);
  }, [activate, cal, stepFrame]);

  /* ------------------------------------------------------------ start and stop */
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  useEffect(() => {
    let dead = false;
    let raf = 0;
    const loop = () => {
      if (dead) return;
      const now = performance.now();
      if (source === "sim") {
        const p = (window as unknown as { __cbHfSim?: Pt | null }).__cbHfSim ?? null;
        st.current.pt = p;
        stepFrame(p, now);
      } else if (source === "scan") {
        const x = st.current;
        if ((now - x.scanAt > Math.max(1200, sRef.current.dwellMs + 400) && !document.querySelector("[data-hf-card]")) || x.scanI < 0) {
          const ts = collectTargets();
          x.scanI = (x.scanI + 1) % Math.max(1, ts.length);
          x.scanAt = now;
          const el = ts[x.scanI];
          if (el) {
            x.held = el;
            x.last = { el, at: Date.now() };
            const r = el.getBoundingClientRect();
            if (box.current) { box.current.style.opacity = "1"; box.current.style.transform = `translate(${r.left - 4}px, ${r.top - 4}px)`; box.current.style.width = `${r.width + 8}px`; box.current.style.height = `${r.height + 8}px`; }
            if (chip.current) chip.current.textContent = nameOf(el);
            if (ring.current) ring.current.style.strokeDashoffset = "113";
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    (async () => {
      if (source === "camera") {
        try {
          setNotice(t("Starting the camera. The face model loads once (about 4 MB); frames stay on this device."));
          const c = await startCamera((f) => onFrameRef.current(f));
          if (dead) return c.stop();
          cam.current = c;
          setNotice("");
          if (mode.current === "gaze" && !loadCalibration()) startCalibration();
          else setStatus("on");
        } catch (e) {
          const why = e instanceof HandsFreeError ? e.why : "model";
          setNotice(
            why === "denied" ? t("Camera permission was refused, so hands-free switched to keyboard scan: the highlight steps through the buttons and Space presses one. Voice still works if it's on.")
            : why === "offline" ? t("You're offline and the face model isn't loaded yet, so hands-free switched to keyboard scan: the highlight steps through the buttons and Space presses one.")
            : why === "no-camera" || why === "unsupported" ? t("No camera here, so hands-free switched to keyboard scan: the highlight steps through the buttons and Space presses one. Voice still works if it's on.")
            : t("The face model didn't load, so hands-free switched to keyboard scan: the highlight steps through the buttons and Space presses one."),
          );
          setSource("scan");
          setStatus("on");
        }
      } else {
        setStatus("on");
        raf = requestAnimationFrame(loop);
      }
    })();
    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      cam.current?.stop();
      cam.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  /* ------------------------------------------------------------ voice */
  useEffect(() => {
    if (s.voice === "off") { setVoiceState("off"); return; }
    if (!voiceSupported()) { setVoiceState("unsupported"); setNotice(t("This browser has no speech recognition, so voice commands are off. Gaze, head and keyboard still work.")); return; }
    const v = startVoice({
      lang, speech: langInfo().speech, mode: s.voice,
      onStop: () => { say(t("Stopped.")); onOff(); },
      onCommand: command,
      onHeard: (h) => { st.current.heard = h; },
      onState: (k, note) => {
        setVoiceState(k);
        if (k === "error" && note === "denied") setNotice(t("Microphone permission was refused, so voice commands are off."));
        if (k === "error" && note === "network") setNotice(t("Speech recognition needs a connection here; voice commands pause until it's back."));
      },
    });
    voice.current = v;
    return () => { v.stop(); voice.current = null; };
  }, [s.voice, lang, command, onOff, say]);

  /* ------------------------------------------------------------ the person's own mouse, keys and test hooks */
  useEffect(() => {
    const x = st.current;
    const onMove = (e: MouseEvent) => {
      if (!e.isTrusted || Math.abs(e.movementX) + Math.abs(e.movementY) < 4 || source === "sim") return;
      x.pausedUntil = performance.now() + 2500;
      setStatus((v) => (v === "on" ? "paused-mouse" : v));
    };
    const onClick = (e: MouseEvent) => {
      if (!e.isTrusted || mode.current !== "gaze" || !x.raw) return;
      if (x.drift.observe(x.raw, { x: e.clientX, y: e.clientY })) x.filter.reset();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (document.querySelector("[data-hf-card]")) { answer(false); e.preventDefault(); return; }
        if (calib) { setCalib(null); setStatus("on"); return; }
        onOff();
        return;
      }
      if (e.altKey && e.shiftKey && e.code === "KeyD") { setHf({ debug: !sRef.current.debug }); e.preventDefault(); }
      if (e.altKey && e.shiftKey && e.code === "KeyC") { if (mode.current === "head") x.noseRef = null; else startCalibration(); e.preventDefault(); }
      if (e.altKey && e.shiftKey && e.code === "KeyV") { voice.current?.talk(); e.preventDefault(); }
      const typing = (e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable='true']");
      if (source === "scan" && !typing && (e.code === "Space" || e.key === "Enter") && x.held && !document.querySelector("[data-hf-card]")) { e.preventDefault(); void activate(x.held); x.scanAt = performance.now() + 1500; }
    };
    const tick = setInterval(() => {
      if (x.pausedUntil && performance.now() > x.pausedUntil) { x.pausedUntil = 0; setStatus((v) => (v === "paused-mouse" ? "on" : v)); }
      if (sRef.current.debug) setDbg({ fps: x.fps, face: Boolean(x.frame?.face) || source !== "camera", yaw: Math.round(x.frame?.yawDeg ?? 0), blinkL: +(x.frame?.blinkL ?? 0).toFixed(2), blinkR: +(x.frame?.blinkR ?? 0).toFixed(2), pt: x.pt ? { x: Math.round(x.pt.x), y: Math.round(x.pt.y) } : null, target: x.held ? nameOf(x.held) : "", vote: x.held ? +x.snapper.vote(x.held).toFixed(1) : 0, acc: cal?.meanPx ?? null, drift: { x: Math.round(x.drift.off.x), y: Math.round(x.drift.off.y) }, heard: x.heard, voice: voiceState, source });
    }, 250);
    addEventListener("mousemove", onMove, true);
    addEventListener("click", onClick, true);
    addEventListener("keydown", onKey, true);
    (window as unknown as { __cbHf: unknown }).__cbHf = {
      // Tests and the demo speak through the same path as the microphone: stop first, then the command grammar.
      say: (text: string) => (isStop(text) ? onOff() : command(text)),
      target: () => (x.held ? nameOf(x.held) : null),
      status: () => status,
      source: () => source,
    };
    return () => {
      clearInterval(tick);
      removeEventListener("mousemove", onMove, true);
      removeEventListener("click", onClick, true);
      removeEventListener("keydown", onKey, true);
    };
  }, [activate, cal, calib, command, onOff, source, startCalibration, status, voiceState]);

  /* ------------------------------------------------------------ what it looks like */
  const dots = nineDots(typeof innerWidth === "number" ? innerWidth : 1280, typeof innerHeight === "number" ? innerHeight : 800);
  const statusText =
    status === "calibrating" ? t("Calibrating")
    : status === "paused-mouse" ? t("Your mouse has control")
    : status === "paused-away" ? t("Paused: look back at the screen")
    : status === "starting" ? t("Starting…")
    : source === "scan" ? t("Keyboard scan")
    : s.mode === "head" ? t("Head pointer on")
    : t("Gaze on");

  return (
    <>
      <div ref={pointer} aria-hidden="true" data-hf-ignore className="pointer-events-none fixed left-0 top-0 z-[75] size-4 rounded-full border-2 border-paper bg-brand opacity-0 shadow transition-opacity" />
      <div ref={box} aria-hidden="true" data-hf-ignore className="pointer-events-none fixed left-0 top-0 z-[74] rounded-[14px] border-[3px] border-brand opacity-0" style={{ boxShadow: "0 0 0 3px var(--paper, #fff)" }}>
        <svg className="absolute -right-5 -top-5 size-10" viewBox="0 0 40 40">
          <circle cx="20" cy="20" r="18" fill="var(--paper, #fff)" stroke="currentColor" strokeOpacity="0.15" strokeWidth="4" />
          <circle ref={ring} cx="20" cy="20" r="18" fill="none" stroke="var(--brand, #2a6)" strokeWidth="4" strokeDasharray="113" strokeDashoffset="113" transform="rotate(-90 20 20)" />
        </svg>
        <span ref={chip} className="absolute -bottom-7 left-0 max-w-[16rem] truncate rounded bg-ink px-2 py-0.5 text-xs text-paper" />
      </div>

      <div role="status" aria-live="polite" className="sr-only" data-testid="hf-live">{live}</div>

      <div data-hf-bar className="fixed bottom-24 left-3 z-[70] flex max-w-[calc(100vw-1.5rem)] flex-wrap items-center gap-2 rounded-[14px] border border-line bg-surface/95 p-2 text-sm shadow-lg backdrop-blur lg:bottom-4" role="region" aria-label={t("Hands-free controls")}>
        <span className="flex items-center gap-2 px-2 font-medium" data-testid="hf-status">
          {source === "camera" ? <><span className="size-2.5 animate-pulse rounded-full bg-[var(--danger,#c33)]" aria-hidden="true" /><Camera className="size-4" aria-hidden="true" />{t("Camera on, on this device only")}</> : source === "sim" ? <><Crosshair className="size-4" aria-hidden="true" />{t("Simulated gaze (no camera)")}</> : <><Keyboard className="size-4" aria-hidden="true" />{t("No camera in use")}</>}
          <span className="text-ink-2">· {statusText}</span>
        </span>
        {source === "camera" ? (
          <button type="button" className="min-h-11 rounded-[10px] border border-line px-3" onClick={() => setHf({ mode: s.mode === "gaze" ? "head" : "gaze" })} aria-label={s.mode === "gaze" ? t("Switch to head pointer") : t("Switch to gaze")}>
            {s.mode === "gaze" ? <Move className="inline size-4" aria-hidden="true" /> : <Eye className="inline size-4" aria-hidden="true" />} {s.mode === "gaze" ? t("Head") : t("Gaze")}
          </button>
        ) : null}
        {source === "camera" && s.mode === "gaze" ? <button type="button" className="min-h-11 rounded-[10px] border border-line px-3" onClick={() => startCalibration()}>{t("Calibrate")}</button> : null}
        {s.voice !== "off" ? <button type="button" className="min-h-11 rounded-[10px] border border-line px-3" onClick={() => voice.current?.talk()} aria-label={t("Talk: say one command")}><Mic className="inline size-4" aria-hidden="true" /> {voiceState === "listening" ? t("Listening") : t("Talk")}</button> : null}
        <button type="button" className="min-h-11 rounded-[10px] border border-line px-3" onClick={() => setHf({ debug: !s.debug })} aria-pressed={s.debug} aria-label={t("Debug panel")}><Bug className="inline size-4" aria-hidden="true" /></button>
        <button type="button" data-risk="none" className="min-h-11 rounded-[10px] bg-ink px-3 font-medium text-paper" onClick={onOff}><Square className="inline size-4" aria-hidden="true" /> {t("Stop hands-free")}</button>
        {notice ? <p className="basis-full px-2 pb-1 text-xs text-ink-2" data-testid="hf-notice">{notice}</p> : null}
        {moved && !calib ? (
          <p className="basis-full px-2 pb-1 text-xs">
            {t("You've moved since calibrating, so gaze may drift.")}{" "}
            <button type="button" className="min-h-11 underline" onClick={() => startCalibration(true)}>{t("Quick 3-dot top-up")}</button>
          </p>
        ) : null}
      </div>

      {calib ? (
        <div className="fixed inset-0 z-[85] bg-paper/95" role="dialog" aria-modal="true" aria-label={t("Calibration")} data-hf-ignore>
          {!calib.result ? (
            <>
              <p className="mx-auto mt-[40vh] max-w-md px-6 text-center text-sm text-ink-2">{t("Look at each dot until it moves. Keep your head still. Esc cancels.")} ({Math.min(calib.i + 1, calib.dots.length)}/{calib.dots.length})</p>
              {calib.dots[calib.i] !== undefined ? <span aria-hidden="true" className="absolute size-6 -translate-x-1/2 -translate-y-1/2 animate-pulse rounded-full border-4 border-paper bg-brand shadow-lg" style={{ left: dots[calib.dots[calib.i]].x, top: dots[calib.dots[calib.i]].y }} /> : null}
            </>
          ) : (
            <div className="mx-auto mt-[25vh] max-w-md rounded-[14px] border border-line bg-surface p-6 text-center">
              <h2 className="text-lg font-semibold">{t("Calibration done")}</h2>
              <p className="mt-2 text-sm">{t("Accuracy: about {0} px on average, {1} px at the worst dot. Measured by leaving each dot out of the fit and checking where it lands.", [calib.result.meanPx, calib.result.worstPx])}</p>
              {calib.result.meanPx > 160 ? <p className="mt-2 text-sm text-ink-2">{t("That's loose for small buttons. Try again in better light, or switch to the head pointer.")}</p> : null}
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <button type="button" className="min-h-11 rounded-[10px] bg-ink px-4 font-medium text-paper" onClick={() => { setCalib(null); setStatus("on"); }}>{t("Use it")}</button>
                <button type="button" className="min-h-11 rounded-[10px] border border-line px-4" onClick={() => startCalibration()}>{t("Calibrate again")}</button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {req ? (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-ink/40 p-4" data-hf-card>
          <div role="alertdialog" aria-modal="true" aria-labelledby="hf-card-title" aria-describedby="hf-card-text" className="w-full max-w-md rounded-[14px] border border-line bg-surface p-6 shadow-xl">
            <h2 id="hf-card-title" className="text-lg font-semibold">{req.risk === "handover" ? t("Leaving for PayPal") : t("Check before it happens")}</h2>
            <p id="hf-card-text" className="mt-2 text-[0.95rem]">{req.text}</p>
            {req.risk !== "handover" && req.label ? <p className="mt-2 text-sm text-ink-2">{t("Button: {0}", [req.label])}</p> : null}
            <p className="mt-3 text-xs text-ink-2">{t("Look at Confirm for twice as long, say “confirm”, or press it. Cancel, Esc or “stop” leaves everything as it was.")}</p>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <button type="button" autoFocus className="min-h-16 rounded-[14px] border border-line px-4 text-base font-medium" onClick={() => answer(false)}>{t("Cancel")}</button>
              <button type="button" data-hf-confirm className="min-h-16 rounded-[14px] bg-ink px-4 text-base font-semibold text-paper" onClick={() => answer(true)}>{req.risk === "handover" ? t("Go to PayPal") : t("Confirm")}</button>
            </div>
          </div>
        </div>
      ) : null}

      {s.debug && dbg ? (
        <div className="fixed right-3 top-16 z-[71] w-64 rounded-[14px] border border-line bg-surface/95 p-3 font-mono text-[0.7rem] shadow-lg" data-hf-ignore role="region" aria-label={t("Hands-free debug panel")}>
          <div>{t("source")}: {dbg.source} · {t("{0} fps", [dbg.fps])}</div>
          <div>{t("face")}: {String(dbg.face)} · {t("yaw")} {dbg.yaw}°</div>
          <div>{t("blink")} L {dbg.blinkL} · R {dbg.blinkR}</div>
          <div>{t("point")}: {dbg.pt ? `${dbg.pt.x}, ${dbg.pt.y}` : "—"}</div>
          <div className="truncate">{t("target")}: {dbg.target || "—"} ({dbg.vote})</div>
          <div>{t("calibration")}: {dbg.acc === null ? "—" : `${dbg.acc} px`}</div>
          <div>{t("drift correction")}: {dbg.drift.x}, {dbg.drift.y}</div>
          <div>{t("voice")}: {dbg.voice}</div>
          <div className="truncate">{t("heard")}: {dbg.heard ? `${dbg.heard.text}${dbg.heard.gated ? ` [${dbg.heard.gated}]` : ""}` : "—"}</div>
        </div>
      ) : null}
    </>
  );
}
