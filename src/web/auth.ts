import type { NextFunction, Request, Response } from "express";
import { getDb } from "../db.js";
import { sign, unsign } from "../lib/crypto.js";
import { GtError, hashKey } from "../lib/util.js";
import { personById, type Person } from "../store.js";
import { back } from "./common.js";

export const COOKIE = "cb_who";
export type Me = Person & { business_name: string };

export async function me(req: Request): Promise<Me | null> {
  const v = unsign(req.cookies?.[COOKIE]);
  if (!v) return null;
  return personById(await getDb(), v);
}

export async function personByKey(key: string): Promise<Me | null> {
  const db = await getDb();
  const r = (await db.query<{ id: string }>("SELECT id FROM people WHERE key_hash = $1", [hashKey(key.trim())])).rows[0];
  return r ? personById(db, r.id) : null;
}

export function signIn(res: Response, p: Person, secure: boolean) {
  res.cookie(COOKIE, sign(p.id), { httpOnly: true, sameSite: "lax", secure, maxAge: 7 * 864e5, path: "/" });
}

export function signOut(res: Response) {
  res.clearCookie(COOKIE, { path: "/" });
}

/** GET page that needs a signed-in person. */
export function authed(fn: (req: Request, res: Response, p: Me) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const p = await me(req);
      if (!p) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl.slice(0, 200))}`);
      await fn(req, res, p);
    } catch (e) {
      if (e instanceof GtError && e.status === 404) return res.status(404).send("Not found");
      next(e);
    }
  };
}

/** POST action: business errors redirect back with the message. */
export function act(fn: (req: Request, res: Response, p: Me) => Promise<unknown>) {
  return authed(async (req, res, p) => {
    try {
      await fn(req, res, p);
    } catch (e) {
      if (e instanceof GtError) {
        if (e.status === 404) return res.status(404).send("Not found");
        const to = (req.get("referer") ?? "/today").replace(/[?&](ok|err)=[^&#]*/g, "").split("#")[0];
        return back(res, to, e.message, true);
      }
      throw e;
    }
  });
}

export const ownerOnly = (p: Me) => {
  if (p.role !== "owner") throw new GtError("Only the owner can do this.", "forbidden", 403);
};

export async function requireOwner(req: Request): Promise<Me> {
  const p = await me(req);
  if (!p || p.role !== "owner") throw new GtError("Owner required", "unauthorized", 401);
  return p;
}
