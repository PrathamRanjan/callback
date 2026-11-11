/**
 * The owner settles a deposit hold after the appointment (spec B2 item 3): "Attended: charge" captures the PayPal
 * authorization; "Cancelled in time: release" voids it. Both pass the gate; the owner's click is the approval.
 */
import { Router } from "express";
import { getDb } from "../db.js";
import { GtError } from "../lib/util.js";
import { settleHold } from "../services/holds.js";
import { bizById } from "../store.js";
import { startRun } from "../trace.js";
import { act } from "./auth.js";
import { back } from "./common.js";

export function holdsRouter(): Router {
  const r = Router();
  for (const how of ["capture", "void"] as const) {
    r.post(`/holds/:id/${how}`, act(async (req, res, p) => {
      if (p.role !== "owner") throw new GtError("Only the owner can charge or release a hold.", "forbidden", 403);
      const db = await getDb();
      const biz = await bizById(db, p.business_id);
      const run = await startRun({ actor: "owner", subject: how === "capture" ? "Charge a deposit hold (attended)" : "Release a deposit hold (cancelled in time)", entity: "hold", entityId: req.params.id }, db);
      try {
        const out = await settleHold({ q: db, run, businessId: biz.id, businessName: biz.name, callId: null, agentScope: "owner", personInitiated: true }, req.params.id, how);
        await run.end("done");
        back(res, "/money#holds", out.message);
      } catch (e) {
        await run.end("failed");
        throw e;
      }
    }));
  }
  return r;
}
