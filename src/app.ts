import compression from "compression";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installChannelHandlers } from "./channels/handlers.js";
import { GtError } from "./lib/util.js";
import { config } from "./config.js";
import { getDb, inWorkspace } from "./db.js";
import { workspaceMiddleware } from "./web/workspace.js";
import { askRouter } from "./web/ask.js";
import { publicRouter } from "./web/public.js";
import { callsRouter } from "./web/calls.js";
import { liveRouter } from "./web/live.js";
import { holdsRouter } from "./web/holds.js";
import { customerRouter } from "./web/customer.js";
import { demoRouter } from "./web/demo.js";
import { foundationRouter } from "./web/foundation.js";
import { guardRouter } from "./web/guard.js";
import { safetyRouter } from "./web/safety.js";
import { ownerRouter } from "./web/owner.js";
import { apiRouter, appJson, webApp, webDist } from "./web/api.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function createApp() {
  installChannelHandlers();
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  // gzip pages, scripts and JSON. Not MCP (streamed responses) or webhooks.
  app.use(compression({ filter: (req, res) => !/^\/(mcp|webhooks)(\/|$)|\/mcp$|\/live\/events$/.test(req.path) && compression.filter(req, res) }));
  app.use(express.urlencoded({ extended: false, limit: "200kb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use("/static", express.static(join(root, "public"), { maxAge: 0, setHeaders: (res, file) => { if (/[\\/]safety[\\/]/.test(file)) res.setHeader("Cache-Control", "public, max-age=86400"); } }));
  // Health (spec A4): the database answers, and which build is running.
  app.get("/healthz", async (_req, res) => {
    const t0 = Date.now();
    try {
      const db = await getDb();
      await inWorkspace(null, () => db.query("SELECT 1"));
      res.json({ ok: true, commit: config.commit || null, db: db.kind, db_ms: Date.now() - t0 });
    } catch (e) {
      res.status(503).json({ ok: false, commit: config.commit || null, error: "database unavailable" });
    }
  });
  // The web app (web/, built to dist/client): hashed assets, then index.html for browser page loads.
  app.use("/assets", express.static(join(webDist(), "assets"), { maxAge: "365d", immutable: true }));
  app.use(express.static(webDist(), { index: false, maxAge: "1d" }));
  app.use(workspaceMiddleware());
  app.use(appJson);
  app.use(webApp());
  app.use(apiRouter());
  app.use(ownerRouter());
  app.use(liveRouter());
  app.use(holdsRouter());
  app.use(callsRouter());
  app.use(guardRouter());
  app.use(safetyRouter());
  app.use(askRouter());
  app.use(publicRouter());
  app.use(customerRouter());
  app.use(demoRouter());
  app.use(foundationRouter());
  app.use((req, res) => res.status(404).send(`Not found: ${req.method} ${req.path}`));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof GtError) return res.status(err.status).send(err.message);
    console.error(err);
    res.status(500).send("Something went wrong; nothing was charged. The error is in the server log.");
  });
  return app;
}
