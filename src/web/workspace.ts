/**
 * Which workspace a request belongs to (spec A1). In order: a workspace-scoped secret in the path or the bearer key
 * (a customer's link opened on a phone, an MCP client), a phone-call webhook's call id, then the visitor's signed
 * cookie. Everything downstream (every query, job and PayPal call) runs inside that workspace.
 */
import type { NextFunction, Request, Response } from "express";
import { inWorkspace } from "../db.js";
import { sign, unsign } from "../lib/crypto.js";
import { getWorkspace, touchWorkspace, wsForRef, wsFromSecret, type Workspace } from "../services/workspaces.js";

export const WS_COOKIE = "cb_ws";

export function setWorkspaceCookie(res: Response, id: string, secure: boolean) {
  res.cookie(WS_COOKIE, sign(id), { httpOnly: true, sameSite: "lax", secure, maxAge: 30 * 864e5, path: "/" });
}
export function clearWorkspaceCookie(res: Response) {
  res.clearCookie(WS_COOKIE, { path: "/" });
}

export const workspaceOf = (req: Request): Workspace | null => (req as any).cbWorkspace ?? null;

function secretInRequest(req: Request): string | null {
  const path = /^\/(?:api\/app\/)?c\/([^/]+)/.exec(req.path);
  if (path) return decodeURIComponent(path[1]);
  const auth = /^Bearer\s+(\S+)/i.exec(req.get("authorization") ?? "");
  if (auth) return auth[1];
  if (typeof req.query.token === "string") return req.query.token;
  return null;
}

export function workspaceMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      let ws: string | null = wsFromSecret(secretInRequest(req));
      let fromCookie = false;
      const voice = /^\/webhooks\/voice\/(?:twiml|gather|status|live)\/([^/]+)/.exec(req.path);
      if (!ws && voice) ws = await wsForRef(voice[1]);
      if (!ws && !req.path.startsWith("/webhooks/")) {
        ws = unsign(req.cookies?.[WS_COOKIE]);
        fromCookie = Boolean(ws);
      }
      let w: Workspace | null = null;
      if (ws) {
        w = await getWorkspace(ws);
        if (!w || new Date(w.expires_at).getTime() < Date.now() || w.seed_state === "failed") {
          if (fromCookie) clearWorkspaceCookie(res);
          w = null;
        } else void touchWorkspace(w.id).catch(() => undefined);
      }
      (req as any).cbWorkspace = w;
      inWorkspace(w?.id ?? null, () => next());
    } catch (e) {
      next(e);
    }
  };
}
