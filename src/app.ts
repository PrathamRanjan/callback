import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installChannelHandlers } from "./channels/handlers.js";
import { GtError } from "./lib/util.js";
import { callsRouter } from "./web/calls.js";
import { customerRouter } from "./web/customer.js";
import { demoRouter } from "./web/demo.js";
import { foundationRouter } from "./web/foundation.js";
import { guardRouter } from "./web/guard.js";
import { safetyRouter } from "./web/safety.js";
import { ownerRouter } from "./web/owner.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function createApp() {
  installChannelHandlers();
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.urlencoded({ extended: false, limit: "200kb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use("/static", express.static(join(root, "public"), { maxAge: "1h" }));
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.use(ownerRouter());
  app.use(callsRouter());
  app.use(guardRouter());
  app.use(safetyRouter());
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
