/** Talks to the Express app. Reads: /api/app/*. Actions: the existing form routes, answered as JSON (X-Callback-App). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly to?: string) {
    super(message);
  }
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(path, { headers: { accept: "application/json" }, credentials: "same-origin", signal });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new ApiError(body?.message ?? `Could not load (${r.status}).`, r.status);
  return body as T;
}

export interface ActResult {
  ok: boolean;
  message: string;
  to?: string;
  external?: boolean;
}

/** Posts a form to an action route. Resolves with {ok, message, to}; rejects with ApiError on a refusal. */
export async function act(path: string, fields: Record<string, string | number | boolean | null | undefined> = {}): Promise<ActResult> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) body.set(k, String(v));
  let r: Response;
  try {
    r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "x-callback-app": "1" }, body });
  } catch {
    throw new ApiError("You look offline. Nothing was sent; try again when you have signal.", 0);
  }
  const out = (await r.json().catch(() => null)) as (ActResult & { error?: string }) | null;
  if (!r.ok || !out || out.ok === false) throw new ApiError(out?.message ?? `That did not work (${r.status}).`, r.status, out?.to);
  return out;
}

/** JSON POST (live voice, scam scan, passkey). */
export async function postJson<T>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => null);
  if (!r.ok) throw new ApiError(out?.message ?? out?.error ?? `That did not work (${r.status}).`, r.status);
  return out as T;
}
