import { useEffect, useRef } from "react";

/**
 * One polite live region for the whole app (spec A7): every payment status change is said through it, once, in
 * words. It is mounted once in main.tsx (<StatusAnnouncer />); pages call announce() or useStatusAnnouncer().
 */
export const LIVE_ID = "cb-status-live";

export function announce(text: string) {
  const el = document.getElementById(LIVE_ID);
  if (!el || !text) return;
  // Clear first so the same words said twice in a row are announced again.
  el.textContent = "";
  setTimeout(() => {
    el.textContent = text;
  }, 60);
}

/**
 * Watches a list of money records and announces each status change after the first load, e.g.
 * "Priya Shah, Deposit for 6-week reformer block: paid". `say` turns a status into the words shown on screen.
 */
export function useStatusAnnouncer<T>(rows: T[] | undefined, key: (r: T) => string, status: (r: T) => string, label: (r: T) => string, say: (s: string) => string) {
  const seen = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    if (!rows) return;
    const now = new Map(rows.map((r) => [key(r), status(r)]));
    const before = seen.current;
    seen.current = now;
    if (!before) return;
    const changed = rows.filter((r) => before.has(key(r)) && before.get(key(r)) !== status(r));
    if (changed.length) announce(changed.map((r) => `${label(r)}: ${say(status(r))}`).join(". "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
}
