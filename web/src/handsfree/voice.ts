/**
 * Voice for hands-free (spec A6). Uses the browser's own speech recognition (Web Speech API), in the page's language.
 * In Chrome that recognition runs on Google's servers; Safari and Edge use their own. Callback receives text only.
 *
 *  - Wake word: always listening, but a command counts only after "Callback" (or within 6 seconds of it).
 *  - Push to talk: listens for one command after a press, up to 8 seconds.
 *  - Stop: checked first, in code, in every language, with or without the wake word.
 *  - Noise gate: drops results the recogniser itself scores below 0.5, and anything under two letters.
 *  - Echo gate: drops anything heard while this page is speaking or playing call audio, and for 0.7 s after, so
 *    Callback never obeys its own voice or a customer on a live call.
 */
import { isStop, afterWake, type HfLang } from "./words";

type Rec = { lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number; start(): void; stop(): void; abort(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null };

export const voiceSupported = () => typeof window !== "undefined" && Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

let speakingUntil = 0;
/** True while this page is speaking or playing audio (a live call), and briefly after. */
export function echoGateClosed(now = Date.now()): boolean {
  if (typeof window === "undefined") return false;
  if (window.speechSynthesis?.speaking) {
    speakingUntil = now + 700;
    return true;
  }
  const playing = [...document.querySelectorAll("audio, video")].some((m) => !(m as HTMLMediaElement).paused && !(m as HTMLMediaElement).muted);
  if (playing || (window as any).__cbLiveAudio) {
    speakingUntil = now + 700;
    return true;
  }
  return now < speakingUntil;
}

/** Says a short line back, in the page language, if the browser can. The echo gate covers it. */
export function speak(text: string, speech: string) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = speech;
    u.rate = 1.05;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch {
    /* no speech synthesis */
  }
}

export interface Heard { text: string; conf: number; gated?: "noise" | "echo" | "wake" }
export interface VoiceCtl { stop(): void; talk(): void; mode: "wake" | "ptt" }

export function startVoice(o: { lang: HfLang; speech: string; mode: "wake" | "ptt"; onStop: () => void; onCommand: (text: string) => void; onHeard: (h: Heard) => void; onState: (s: "listening" | "idle" | "error", note?: string) => void }): VoiceCtl {
  const R = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!R) {
    o.onState("error", "no-speech");
    return { stop() {}, talk() {}, mode: o.mode };
  }
  let alive = true;
  let listening = false;
  let wakeUntil = 0;
  let pttUntil = 0;
  const rec: Rec = new R();
  rec.lang = o.speech;
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onresult = (e: any) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const text = String(r[0]?.transcript ?? "").trim();
      const conf = Number(r[0]?.confidence ?? 0);
      // Stop wins over everything, even an unfinished phrase, and doesn't need the wake word.
      if (isStop(text)) {
        o.onHeard({ text, conf });
        o.onStop();
        return;
      }
      if (!r.isFinal) continue;
      if (echoGateClosed()) { o.onHeard({ text, conf, gated: "echo" }); continue; }
      if (text.replace(/\s/g, "").length < 2 || (conf > 0 && conf < 0.5)) { o.onHeard({ text, conf, gated: "noise" }); continue; }
      const now = Date.now();
      if (o.mode === "ptt") {
        if (now > pttUntil) { o.onHeard({ text, conf, gated: "wake" }); continue; }
        pttUntil = 0;
        o.onHeard({ text, conf });
        o.onCommand(text);
        continue;
      }
      const rest = afterWake(text, o.lang);
      if (rest === null && now > wakeUntil) { o.onHeard({ text, conf, gated: "wake" }); continue; }
      o.onHeard({ text, conf });
      if (rest === "") { wakeUntil = now + 6000; continue; }
      wakeUntil = 0;
      o.onCommand(rest ?? text);
    }
  };
  rec.onerror = (e: any) => {
    if (e?.error === "not-allowed" || e?.error === "service-not-allowed") {
      alive = false;
      o.onState("error", "denied");
    } else if (e?.error === "network") o.onState("error", "network");
  };
  rec.onend = () => {
    listening = false;
    // Browsers end recognition after a silence; keep it going while hands-free voice is on.
    if (alive) setTimeout(() => { if (alive && !listening) begin(); }, 250);
    else o.onState("idle");
  };
  const begin = () => {
    try {
      rec.start();
      listening = true;
      o.onState("listening");
    } catch {
      /* already started */
    }
  };
  begin();
  return {
    mode: o.mode,
    talk() { pttUntil = Date.now() + 8000; o.onState("listening"); },
    stop() {
      alive = false;
      try { rec.abort(); } catch { /* not started */ }
    },
  };
}
