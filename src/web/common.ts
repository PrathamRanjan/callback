import type { NextFunction, Request, Response } from "express";
import { GtError } from "../lib/util.js";

export const flashOf = (req: Request) => ({
  ok: typeof req.query.ok === "string" ? req.query.ok.slice(0, 200) : undefined,
  err: typeof req.query.err === "string" ? req.query.err.slice(0, 200) : undefined,
});

export function back(res: Response, to: string, msg: string, isErr = false) {
  const [path, hash] = to.split("#");
  const sep = path.includes("?") ? "&" : "?";
  res.redirect(`${path}${sep}${isErr ? "err" : "ok"}=${encodeURIComponent(msg)}${hash ? `#${hash}` : ""}`);
}

/** Wraps a page handler: GtErrors become a redirect back with the message; JSON routes get JSON errors. */
export function page(fn: (req: Request, res: Response) => Promise<unknown>, errorTo?: (req: Request) => string) {
  return (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch((e) => {
      if (e instanceof GtError) {
        if (e.status === 404 && !req.is("application/json")) return res.status(404).send("Not found");
        if (req.accepts(["html", "json"]) === "json" || req.is("application/json")) return res.status(e.status).json({ error: e.code, message: e.message });
        return back(res, errorTo ? errorTo(req) : req.get("referer")?.replace(/[?&](ok|err)=[^&]*/g, "") || "/", e.message, true);
      }
      next(e);
    });
}

export function json(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) =>
    fn(req, res)
      .then((out) => {
        if (!res.headersSent) res.json(out);
      })
      .catch((e) => {
        if (e instanceof GtError) return res.status(e.status).json({ error: e.code, message: e.message });
        next(e);
      });
}
