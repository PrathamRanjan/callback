/**
 * Decisions client (spec A5.2). One request asks every question about the same evidence and gets probabilities back:
 * a yes/no `predicate`, a `choice` among values, or a `score` on labelled levels. The vendor is hidden behind
 * `decide()` so a second opinion (another provider) can be added later without touching callers.
 *
 * Honesty rules:
 *  - No key, the rules arm, a failed request or a `refusal` answer all mean "not decided". Callers treat that as a
 *    reader that did not run: it can never produce an all-clear, and a person decides instead.
 *  - Thresholds are not the model's: they live in `thresholds.json` (written by `scripts/calibrate.ts` from a labelled
 *    set) and are copied into the `decision_thresholds` table so the proof page shows what is in force.
 *  - Every call is a row in `ai_calls` with the questions, the answers, latency and tokens.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import type { Queryable } from "../db.js";
import { audit, estimateCost, fetchImpl, hasOpenAI, NoModelError, type Purpose } from "./provider.js";

export type Question =
  | { type: "predicate"; name: string; instructions: string }
  | { type: "choice"; name: string; instructions: string; choices: { value: string; description: string }[] }
  | { type: "score"; name: string; instructions: string; levels: { label: string; description: string }[] };

export type InputPart = { type: "input_text"; text: string } | { type: "input_image"; image_url: string } | { type: "input_json"; data: unknown };

export interface Answer {
  probability?: number;
  choice?: string;
  score?: number;
  confidence?: number;
  /** The model declined this question: route it to a person. */
  refused?: boolean;
}

export interface Decided {
  answers: Record<string, Answer>;
  model: string;
  latencyMs: number;
  tokensIn: number;
  costUsd: number;
  auditId: number | null;
}

export class NotDecidedError extends NoModelError {}

/** True when a Decisions request can run here (the deployed app; never the rules arm). */
export const decisionsAvailable = () => hasOpenAI();

function hashOf(input: string | InputPart[], questions: Question[], system: string): string {
  return createHash("sha256").update(system).update("\u0000").update(JSON.stringify(input)).update("\u0000").update(JSON.stringify(questions)).digest("hex");
}

/** The exact body sent, exposed for the secret-leak and structure tests. */
export function decisionsBody(input: string | InputPart[], questions: Question[], system?: string) {
  const parts: InputPart[] = typeof input === "string" ? [{ type: "input_text", text: input }] : input;
  return {
    model: config.ai.models.decisions,
    input: [...(system ? [{ role: "developer", content: [{ type: "input_text", text: system }] }] : []), { role: "user", content: parts }],
    questions,
  };
}

/** Ask every question about one piece of evidence. Throws NotDecidedError when no answer can be had. */
export async function decide(input: string | InputPart[], questions: Question[], meta: { purpose: Purpose; ws?: string | null; runId?: string | null; system?: string }): Promise<Decided> {
  if (!questions.length || questions.length > 400) throw new Error("A Decisions request takes 1 to 400 questions");
  const system = meta.system ?? "";
  const inputHash = hashOf(input, questions, system);
  if (!decisionsAvailable()) throw new NotDecidedError("No Decisions model here (AI_PROVIDER is not openai or the key is unset)");
  const model = config.ai.models.decisions;
  const t0 = Date.now();
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(`${config.ai.openaiBaseUrl}/v1/decisions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.ai.openaiKey}`, "content-type": "application/json" },
        body: JSON.stringify(decisionsBody(input, questions, system || undefined)),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        lastErr = `Decisions ${res.status}`;
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`Decisions ${res.status}: ${text.slice(0, 200)}`);
      const data = JSON.parse(text);
      const answers: Record<string, Answer> = {};
      for (const a of data.answers ?? []) {
        if (!a?.name) continue;
        if (a.type === "refusal") answers[a.name] = { refused: true };
        else if (a.type === "predicate") answers[a.name] = { probability: Number(a.probability) };
        else if (a.type === "choice") answers[a.name] = { choice: String(a.choice), confidence: Number(a.confidence), probability: Number(a.probabilities?.find((p: any) => p.value === a.choice)?.probability ?? NaN) };
        else if (a.type === "score") answers[a.name] = { score: Number(a.score), confidence: Number(a.confidence) };
      }
      // A question with no answer at all is not decided either.
      for (const q of questions) if (!answers[q.name]) answers[q.name] = { refused: true };
      const latencyMs = Date.now() - t0;
      const tokensIn = Number(data.usage?.input_tokens ?? 0);
      const costUsd = estimateCost(data.model ?? model, tokensIn, 0);
      const auditId = await audit({ purpose: meta.purpose, model: data.model ?? model, via: "decisions", inputHash, outputHash: createHash("sha256").update(text).digest("hex"), tokensIn, tokensOut: 0, costUsd, latencyMs, ok: true, error: null, output: { questions: questions.map((q) => q.name), answers }, runId: meta.runId ?? null });
      return { answers, model: data.model ?? model, latencyMs, tokensIn, costUsd, auditId };
    } catch (e) {
      lastErr = (e as Error).message.slice(0, 300);
      if (attempt >= 1 || !/fetch failed|timeout|aborted/i.test(lastErr)) break;
    }
  }
  await audit({ purpose: meta.purpose, model, via: "decisions", inputHash, outputHash: "", tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: Date.now() - t0, ok: false, error: lastErr, output: null, runId: meta.runId ?? null });
  throw new NotDecidedError(`Decisions request failed: ${lastErr}`);
}

/** Thresholds per question: below `clear_below` counts as no, at or above `hold_above` as yes, between as unsure. */
export interface Threshold {
  name: string;
  clear_below: number;
  hold_above: number;
  calibrated_on: string | null;
  n: number;
  precision_at_hold: number | null;
  recall_at_hold: number | null;
  set_at: string;
}

const here = dirname(fileURLToPath(import.meta.url));
let cache: Record<string, Threshold> | null = null;
/** The thresholds in force: `src/ai/thresholds.json` (also copied next to the build), written by scripts/calibrate.ts. */
export function thresholds(): Record<string, Threshold> {
  if (cache) return cache;
  for (const p of [join(here, "thresholds.json"), join(here, "../../src/ai/thresholds.json")]) {
    try {
      cache = JSON.parse(readFileSync(p, "utf8")) as Record<string, Threshold>;
      return cache;
    } catch {
      /* try the next location */
    }
  }
  throw new Error("thresholds.json is missing: run scripts/calibrate.ts");
}
export function setThresholdsForTest(t: Record<string, Threshold> | null) {
  cache = t;
}

/** "yes" | "unsure" | "no" | "not decided" for one predicate answer under its threshold. */
export function verdict(a: Answer | undefined, name: string): "yes" | "unsure" | "no" | "not_decided" {
  if (!a || a.refused || a.probability === undefined || !Number.isFinite(a.probability)) return "not_decided";
  const t = thresholds()[name];
  if (!t) return "not_decided";
  if (a.probability >= t.hold_above) return "yes";
  if (a.probability < t.clear_below) return "no";
  return "unsure";
}

/** Copy the thresholds in force into the table, so the proof page and SQL readers see the same numbers. */
export async function syncThresholds(db: Queryable) {
  for (const t of Object.values(thresholds())) {
    await db.query(
      `INSERT INTO decision_thresholds (name, clear_below, hold_above, calibrated_on, n, precision_at_hold, recall_at_hold, set_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (name) DO UPDATE SET clear_below = EXCLUDED.clear_below, hold_above = EXCLUDED.hold_above, calibrated_on = EXCLUDED.calibrated_on, n = EXCLUDED.n, precision_at_hold = EXCLUDED.precision_at_hold, recall_at_hold = EXCLUDED.recall_at_hold, set_at = EXCLUDED.set_at`,
      [t.name, t.clear_below, t.hold_above, t.calibrated_on, t.n, t.precision_at_hold, t.recall_at_hold, t.set_at],
    );
  }
}
