/**
 * Shared tool executor for the realtime path: a function call from the live model becomes a typed "turn" whose brain
 * decision is replaced by the model's tool choice. It reuses customerSays' executor by feeding a synthetic customer
 * line and forcing the tool, so the gate, trace and transcript are identical.
 */
import type { Queryable } from "../db.js";
import { customerSays, type TurnResult } from "../services/calls.js";
import { callById } from "../store.js";

/** Realtime function call -> executor. The customer's transcribed speech is recorded first when provided. */
export async function executeRealtimeTool(q: Queryable, callId: string, name: string, args: Record<string, unknown>, transcript?: string): Promise<TurnResult | { error: string }> {
  const call = await callById(q, callId);
  if (call.status !== "in_progress") return { error: `call is ${call.status}` };
  // The forced-tool marker is read by services/calls.ts: a line beginning with "\u0001tool:" is a tool request, not speech.
  const line = `\u0001tool:${name}:${typeof args.option_id === "string" ? args.option_id : ""}:${typeof args.outcome === "string" ? args.outcome : ""}\u0001${transcript ?? ""}`;
  return customerSays(q, callId, line, "realtime");
}
