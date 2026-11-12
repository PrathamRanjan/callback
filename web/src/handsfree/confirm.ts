/**
 * The small, always-loaded part of hands-free: whether it is on, and the confirm card (spec A6.5).
 *
 * With hands-free off, confirmAction() is the browser's own confirm dialog, exactly as before. With it on, the same
 * question is asked on Callback's confirm card, which gaze, head, voice and keyboard can all answer, because a native
 * dialog can't be looked at or spoken to. The card is the only way past: the code that presses a risky button for
 * hands-free waits on it, and nothing a model says can answer it.
 */
import { useSyncExternalStore } from "react";
import type { Risk } from "./words";

export interface ConfirmReq { id: number; text: string; risk: Risk | null; label: string; resolve: (ok: boolean) => void }

let active = false;
let req: ConfirmReq | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
/** Elements hands-free has just confirmed, so the button's own confirm doesn't ask a second time. */
const confirmed = new WeakMap<Element, number>();

export const handsFreeOn = () => active;
export function setHandsFreeActive(on: boolean) {
  active = on;
  if (!on && req) answer(false);
  emit();
}
export function useHandsFreeActive() {
  return useSyncExternalStore((cb) => (listeners.add(cb), () => listeners.delete(cb)), () => active);
}

/** Ask on the card. Resolves true only when the person confirms; leaving, Esc, "stop" or "cancel" resolve false. */
export function askCard(text: string, risk: Risk | null, label: string): Promise<boolean> {
  if (req) req.resolve(false);
  return new Promise((resolve) => {
    req = { id: ++seq, text, risk, label, resolve };
    emit();
  });
}
export function answer(ok: boolean) {
  const r = req;
  req = null;
  emit();
  r?.resolve(ok);
}
export function useConfirmReq() {
  return useSyncExternalStore((cb) => (listeners.add(cb), () => listeners.delete(cb)), () => req);
}

export function markConfirmed(el: Element) {
  confirmed.set(el, Date.now());
}

/** Used by every button that asks before acting (ActButton's confirmText). */
export async function confirmAction(text: string, el?: Element | null): Promise<boolean> {
  if (el) {
    const at = confirmed.get(el);
    if (at && Date.now() - at < 4000) {
      confirmed.delete(el);
      return true;
    }
  }
  if (!active) return window.confirm(text);
  return askCard(text, null, (el?.textContent ?? "").trim());
}
