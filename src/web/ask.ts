/**
 * Ask routes (spec A5.3): start a question, stream its steps over server-sent events, read a finished run, and the
 * owner's proposals. Owner only. The stream reads agent_trace, so a reload or a second device sees the same steps.
 */
import { Router, type Request } from "express";
import { currentWs, getDb } from "../db.js";
import { ASK_PRESETS, allowAsk, startAsk } from "../agent/ask.js";
import { brainKind, providerLabel } from "../ai/provider.js";
import { GtError } from "../lib/util.js";
import { markStep } from "../services/workspaces.js";
import { me, type Me } from "./auth.js";
import { json } from "./common.js";
import { langOf } from "../lib/lang.js";

async function owner(req: Request): Promise<Me> {
  const p = await me(req);
  if (!p) throw new GtError("Sign in first.", "unauthorized", 401);
  if (p.role !== "owner") throw new GtError("Only the owner can ask.", "forbidden", 403);
  return p;
}

const parse = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
async function stepsOf(runId: string, after = 0) {
  const db = await getDb();
  return (await db.query<any>("SELECT step, actor, tool, args, result, duration_ms, at FROM agent_trace WHERE run_id = $1 AND step > $2 ORDER BY step", [runId, after])).rows.map((r) => ({ ...r, args: parse(r.args), result: parse(r.result) }));
}
async function runOf(runId: string, businessId: string) {
  const db = await getDb();
  const r = (await db.query<any>("SELECT id, status, subject, started_at, ended_at FROM agent_runs WHERE id = $1 AND entity = 'ask' AND entity_id = $2", [runId, businessId])).rows[0];
  if (!r) throw new GtError("No such question.", "not_found", 404);
  return r;
}

export function askRouter() {
  const r = Router();

  r.get("/api/app/ask", json(async (req) => {
    const p = await owner(req);
    const db = await getDb();
    const runs = (await db.query<any>("SELECT id, status, subject, started_at FROM agent_runs WHERE entity = 'ask' AND entity_id = $1 ORDER BY started_at DESC LIMIT 10", [p.business_id])).rows;
    const proposals = (await db.query<any>("SELECT * FROM proposals WHERE business_id = $1 ORDER BY created_at DESC LIMIT 20", [p.business_id])).rows.map((x) => ({ ...x, payload: parse(x.payload) }));
    return { presets: ASK_PRESETS, runs, proposals, brain: brainKind(), brain_label: providerLabel() };
  }));

  r.post("/api/app/ask", json(async (req) => {
    const p = await owner(req);
    const q = String(req.body?.question ?? "").trim().slice(0, 2000);
    if (!q) throw new GtError("Type a question first.", "bad_request", 400);
    if (brainKind() !== "model") throw new GtError("The AI model isn't available here, so Ask can't run. Nothing was changed.", "ai_unavailable", 503);
    if (!allowAsk(`${currentWs() ?? "base"}:${p.business_id}`)) throw new GtError("That's 20 questions this hour. Try again later.", "rate_limited", 429);
    const { runId, done } = await startAsk(p.business_id, q, p.id, langOf(req));
    void done.then(() => markStep("asked_the_agent").catch(() => undefined));
    return { run_id: runId };
  }));

  r.get("/api/app/ask/:id", json(async (req) => {
    const p = await owner(req);
    return { run: await runOf(req.params.id, p.business_id), steps: await stepsOf(req.params.id) };
  }));

  r.get("/api/app/ask/:id/stream", async (req, res, next) => {
    try {
      const p = await owner(req);
      await runOf(req.params.id, p.business_id);
      res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.flushHeaders();
      let last = Number(req.query.after ?? 0) || 0;
      let open = true;
      req.on("close", () => (open = false));
      const end = Date.now() + 70_000;
      while (open && Date.now() < end) {
        for (const s of await stepsOf(req.params.id, last)) {
          last = s.step;
          res.write(`id: ${s.step}\ndata: ${JSON.stringify(s)}\n\n`);
        }
        const run = await runOf(req.params.id, p.business_id);
        if (run.status !== "running") {
          for (const s of await stepsOf(req.params.id, last)) res.write(`id: ${s.step}\ndata: ${JSON.stringify(s)}\n\n`);
          res.write(`event: end\ndata: ${JSON.stringify({ status: run.status })}\n\n`);
          break;
        }
        await new Promise((ok) => setTimeout(ok, 300));
      }
      res.end();
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof GtError) return res.status(e.status).json({ error: e.code, message: e.message });
      next(e);
    }
  });

  r.post("/api/app/ask/proposals/:id/:act", json(async (req) => {
    const p = await owner(req);
    const act = req.params.act === "done" ? "done" : req.params.act === "dismiss" ? "dismissed" : null;
    if (!act) throw new GtError("Unknown action.", "bad_request", 400);
    const db = await getDb();
    const r = await db.query("UPDATE proposals SET status = $3 WHERE id = $1 AND business_id = $2 AND status = 'open' RETURNING id", [req.params.id, p.business_id, act]);
    if (!r.rows.length && !(await db.query("SELECT 1 FROM proposals WHERE id = $1 AND business_id = $2", [req.params.id, p.business_id])).rows.length) throw new GtError("No such proposal.", "not_found", 404);
    return { ok: true, status: act };
  }));

  return r;
}
