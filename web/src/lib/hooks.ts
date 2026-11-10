import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { ApiError, getJson } from "./api";

export interface Loaded<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => Promise<void>;
}

/** Loads JSON, keeps the last good data while reloading, and optionally polls (paused while the tab is hidden). */
export function useData<T>(path: string | null, opts: { poll?: number } = {}): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const ctl = useRef<AbortController | null>(null);
  // A 401 or 403 will not change by asking again: polling stops until the path changes (a front-desk person on the
  // owner's Needs-you page kept requesting it every 10 seconds before 10 Nov 2026).
  const refused = useRef(false);
  const load = useCallback(async () => {
    if (!path) return;
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setLoading(true);
    try {
      const d = await getJson<T>(path, c.signal);
      setData(d);
      setError(null);
      refused.current = false;
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) refused.current = true;
      setError(e instanceof ApiError ? e : new ApiError((e as Error).message || "Could not load.", 0));
    } finally {
      if (ctl.current === c) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setData(null);
    refused.current = false;
    void load();
    return () => ctl.current?.abort();
  }, [load]);
  useEffect(() => {
    if (!opts.poll) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible" && !refused.current) void load();
    }, opts.poll);
    return () => clearInterval(t);
  }, [load, opts.poll]);
  return { data, error, loading, reload: load };
}

export interface Session {
  me: { name: string; role: "owner" | "staff"; business: string } | null;
  business: { name: string; tz: string; clock: string; clock_local: string; pinned: boolean } | null;
  pending: number;
  demo: boolean;
  workspace: { private: boolean; seed_state: string; seed_note: string; expires_at: string; idle_hours: number; join_url: string | null } | null;
  integrations: { paypal: string | null; brain: "model" | "rules" | "none"; brain_label: string; phone: boolean; realtime: boolean; sms: boolean; telegram: boolean; push: boolean; telegram_bot: string };
}
export const SessionCtx = createContext<{ session: Session | null; loading: boolean; reload: () => Promise<void> }>({ session: null, loading: true, reload: async () => {} });
export const useSession = () => useContext(SessionCtx);

export function useOnline() {
  const [on, setOn] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  useEffect(() => {
    const a = () => setOn(true);
    const b = () => setOn(false);
    addEventListener("online", a);
    addEventListener("offline", b);
    return () => {
      removeEventListener("online", a);
      removeEventListener("offline", b);
    };
  }, []);
  return on;
}

export function useTitle(t: string) {
  useEffect(() => {
    document.title = t ? `${t} · Callback` : "Callback: the money calls, made for you";
  }, [t]);
}

/** Web storage that never throws (private windows, blocked storage); callers always have a default. */
export const store = {
  get(k: string, session = false): string | null {
    try {
      return (session ? sessionStorage : localStorage).getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string, session = false) {
    try {
      (session ? sessionStorage : localStorage).setItem(k, v);
    } catch {
      /* storage blocked: the default stays */
    }
  },
  del(k: string, session = false) {
    try {
      (session ? sessionStorage : localStorage).removeItem(k);
    } catch {
      /* ignore */
    }
  },
};
