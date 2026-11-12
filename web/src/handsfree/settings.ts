/** Hands-free settings and the saved calibration, kept on this device only (localStorage). */
import { useSyncExternalStore } from "react";
import { store } from "@/lib/hooks";
import type { Model } from "./math";

export type HfMode = "gaze" | "head" | "scan";
export type HfVoice = "off" | "wake" | "ptt";
export interface HfSettings { mode: HfMode; dwellMs: number; wink: boolean; voice: HfVoice; speakBack: boolean; debug: boolean }
export const DEFAULTS: HfSettings = { mode: "gaze", dwellMs: 1100, wink: false, voice: "off", speakBack: false, debug: false };

const KEY = "cb-hf";
const CAL = "cb-hf-calib";
const listeners = new Set<() => void>();
let cur: HfSettings = read();

function read(): HfSettings {
  try {
    const v = JSON.parse(store.get(KEY) ?? "{}");
    return { ...DEFAULTS, ...v, dwellMs: Math.min(2500, Math.max(500, Number(v.dwellMs ?? DEFAULTS.dwellMs))) };
  } catch {
    return { ...DEFAULTS };
  }
}
export const hfSettings = () => cur;
export function setHf(p: Partial<HfSettings>) {
  cur = { ...cur, ...p };
  store.set(KEY, JSON.stringify(cur));
  listeners.forEach((l) => l());
}
export function useHf(): HfSettings {
  return useSyncExternalStore((cb) => (listeners.add(cb), () => listeners.delete(cb)), () => cur);
}

export interface Calibration { model: Model; meanPx: number; worstPx: number; at: string; screen: { w: number; h: number }; head: { cx: number; cy: number; scale: number }; dots: number; samples: number }

/** The saved fit, if it was made on a screen this size (a different window size means a new fit). */
export function loadCalibration(w = window.innerWidth, h = window.innerHeight): Calibration | null {
  try {
    const c = JSON.parse(store.get(CAL) ?? "null") as Calibration | null;
    if (!c?.model) return null;
    if (Math.abs(c.screen.w - w) > 80 || Math.abs(c.screen.h - h) > 80) return null;
    return c;
  } catch {
    return null;
  }
}
/** The last fit's numbers, whatever the window size: shown on /accessibility as "your device". */
export function lastCalibration(): Calibration | null {
  try {
    return JSON.parse(store.get(CAL) ?? "null");
  } catch {
    return null;
  }
}
export function saveCalibration(c: Calibration) {
  store.set(CAL, JSON.stringify(c));
}
export function forgetCalibration() {
  try {
    localStorage.removeItem(CAL);
  } catch {
    /* storage blocked */
  }
}
