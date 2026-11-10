/**
 * AI provider layer (roadmap B.1, spec A5.4 and A11). OpenAI Responses API with strict JSON-schema outputs and a model
 * chain: primary model (one repair attempt if its JSON is broken) -> backup model -> stop with NoModelError, which every
 * caller turns into an honest failure state. No rules stand-in and no replayed answer unless a caller asks for one.
 * Every call is audited; the guard helpers (forbidden-field schema checks, grounding) apply to every caller.
 *
 * In Callback the model chooses what the agent says next and which of the code-offered options it picks
 * (an instalment option id, a callback slot id, a discount step id). It never produces an amount, a percentage,
 * a PayPal id or a phone number: `assertSafeSchema` enforces that at call time and the structural test at build time.
 */
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { getDb } from "../db.js";

export type Purpose = "turn" | "policy" | "persona" | "summary" | "eval";

export interface TextPart {
  type: "text";
  text: string;
}
export interface ImagePart {
  type: "image";
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  data: Buffer;
}
export type Part = TextPart | ImagePart;

export interface StructuredCall<T> {
  purpose: Purpose;
  tier: "read" | "classify" | "vision";
  system: string;
  parts: Part[];
  schemaName: string;
  schema: Record<string, unknown>;
  maxOutputTokens?: number;
  /** Pin one model instead of the tier's chain (the call brain's guarded retry asks the backup model directly). */
  model?: string;
  /** Reasoning effort; low by default (extraction and call turns need speed, not long thought). */
  effort?: "low" | "medium" | "high";
  /** Only an offline evaluation may opt in to replaying a recorded answer; the result is labelled via "replay". */
  allowReplay?: boolean;
  runId?: string | null;
  parse?: (raw: unknown) => T;
}

export interface CallResult<T> {
  output: T;
  model: string;
  via: "primary" | "fallback" | "replay";
  inputHash: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  auditId: number | null;
}

export class NoModelError extends Error {
  constructor(msg = "No model available") {
    super(msg);
  }
}

let fetchImpl: typeof fetch = (i, init) => fetch(i, init);
/** Tests intercept model calls here. */
export function setProviderFetch(f: typeof fetch | null) {
  fetchImpl = f ?? ((i, init) => fetch(i, init));
}

export const hasOpenAI = () => config.ai.provider === "openai" && Boolean(config.ai.openaiKey);
/** The deterministic test and offline-evaluation arm (never on the deployed app, never labelled as AI). */
export const rulesArm = () => config.ai.provider === "rules";
/** What actually runs the AI steps, in words. Only models that some step really calls are named. */
export const providerLabel = () =>
  hasOpenAI() ? `OpenAI ${config.ai.models.read} for call turns and reading your policy (backup ${config.ai.models.readBackup})` : rulesArm() ? "rules brain (test and offline evaluation only; not AI)" : "no AI model configured: calls and policy reading show an error instead";
/** The brain label the app shows: "model" only when a model runs. */
export const brainKind = (): "model" | "rules" | "none" => (hasOpenAI() ? "model" : rulesArm() ? "rules" : "none");

/** The plain sentence a person sees when a model step fails (spec A5.5). Never the raw error. */
export const AI_FAILED_MESSAGE = "The AI model couldn't do this step just now. Nothing was changed. Try again in a moment.";

/** Fields a model output schema may never contain. Money, percentages, phone numbers and PayPal identifiers are produced by code. */
export const FORBIDDEN_FIELDS = [/^amount/i, /_cents$/i, /^price/i, /^total/i, /^discount_pct$/i, /^discount_percent/i, /^percent/i, /^instalment_cents/i, /^fee/i, /^refund/i, /^capture/i, /^order_id$/i, /^invoice_id$/i, /^subscription_id$/i, /^plan_id$/i, /^paypal_/i, /^payer_id$/i, /^phone/i, /^to_number$/i, /^receiver/i, /^payment_token/i, /^I-[A-Z0-9]+$/];
/** Read-only observations a schema may carry even though they look like money: quoted from the owner's own text. */
export const ALLOWED_OBSERVATIONS = new Set(["discount_quote", "hours_quote", "instalments_quote", "amount_quote"]);

export function assertSafeSchema(schema: Record<string, unknown>, path = "$"): void {
  const props = (schema.properties ?? {}) as Record<string, any>;
  for (const [k, v] of Object.entries(props)) {
    if (!ALLOWED_OBSERVATIONS.has(k) && FORBIDDEN_FIELDS.some((re) => re.test(k))) throw new Error(`Unsafe model schema: field ${path}.${k} looks like a money, phone or PayPal id field`);
    if (v && typeof v === "object") {
      if (v.properties) assertSafeSchema(v, `${path}.${k}`);
      if (v.items?.properties) assertSafeSchema(v.items, `${path}.${k}[]`);
    }
  }
}

/** OpenAI strict mode needs every property required and additionalProperties:false at every level. */
export function strictify(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  const out: any = Array.isArray(schema) ? schema.map(strictify) : { ...schema };
  if (out.type === "object" || out.properties) {
    out.additionalProperties = false;
    out.properties = Object.fromEntries(Object.entries(out.properties ?? {}).map(([k, v]) => [k, strictify(v)]));
    out.required = Object.keys(out.properties);
  }
  if (out.items) out.items = strictify(out.items);
  if (out.anyOf) out.anyOf = out.anyOf.map(strictify);
  delete out.default;
  delete out.format;
  return out;
}

/**
 * USD per million tokens [input, output]. GPT-6 rates are OpenAI list prices as reported by secondary pricing pages
 * on 11 Nov 2026 (OpenAI's own page was not read); a model not listed is costed at the highest listed rate so the
 * estimate errs high, and the evidence page calls these figures estimates.
 */
const PRICE: Record<string, [number, number]> = {
  "gpt-6.1-sol": [2, 10],
  "gpt-6-sol": [2, 10],
  "gpt-6-luna": [0.1, 0.5],
  "gpt-5.5": [5, 20],
  "gpt-5.4": [2.5, 10],
  "gpt-5.4-mini": [0.4, 1.6],
  "gpt-5.4-nano": [0.1, 0.4],
  "gpt-5.6-luna": [4, 16],
  "gpt-realtime": [32, 64],
};
export function estimateCost(model: string, tin: number, tout: number): number {
  const p = PRICE[model] ?? PRICE[model.replace(/-\d{4}-\d{2}-\d{2}$/, "")] ?? [32, 64];
  return (tin * p[0] + tout * p[1]) / 1e6;
}

function chainFor(tier: StructuredCall<unknown>["tier"]): string[] {
  const m = config.ai.models;
  const uniq = (xs: string[]) => [...new Set(xs)];
  if (tier === "vision") return uniq([m.vision, m.readBackup]);
  if (tier === "read") return uniq([m.read, m.readBackup]);
  return uniq([m.classify, m.read]);
}

export function hashInput(call: { system: string; parts: Part[]; schemaName: string }): string {
  const h = createHash("sha256");
  h.update(call.system).update("\u0000").update(call.schemaName).update("\u0000");
  for (const p of call.parts) {
    if (p.type === "text") h.update("t:").update(p.text);
    else h.update("i:").update(createHash("sha256").update(p.data).digest("hex"));
  }
  return h.digest("hex");
}

function toInput(parts: Part[]) {
  return parts.map((p) => (p.type === "text" ? { type: "input_text", text: p.text } : { type: "input_image", image_url: `data:${p.mediaType};base64,${Buffer.from(p.data).toString("base64")}`, detail: "high" }));
}

/** The exact request body sent to OpenAI, exposed so the secret-leak test can inspect what a prompt contains. */
export function requestBody(model: string, call: StructuredCall<unknown>, schema: any) {
  return {
    model,
    instructions: call.system,
    input: [{ role: "user", content: toInput(call.parts) }],
    text: { format: { type: "json_schema", name: call.schemaName, strict: true, schema } },
    // Spec A5.4: at least 4,000 output tokens so reasoning plus JSON never runs out mid-string.
    max_output_tokens: Math.max(4000, call.maxOutputTokens ?? 0),
    reasoning: { effort: call.effort ?? "low" },
    store: false,
  };
}

/** One repair attempt for broken JSON: the same model gets its own text back and returns valid JSON for the schema. */
function repairBody(model: string, call: StructuredCall<unknown>, schema: any, broken: string, why: string) {
  return {
    ...requestBody(model, call, schema),
    instructions: "Your previous reply was not valid JSON for the schema. Return valid JSON for this schema, keeping the same content. Output only the JSON.",
    input: [{ role: "user", content: [{ type: "input_text", text: `Error: ${why}\nPrevious reply:\n${broken.slice(0, 6000)}` }] }],
  };
}

async function openaiStructured(model: string, call: StructuredCall<unknown>, schema: any): Promise<{ raw: unknown; tokensIn: number; tokensOut: number; model: string; repaired: boolean }> {
  let last: unknown;
  let body: unknown = requestBody(model, call, schema);
  let repaired = false;
  let tin = 0;
  let tout = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetchImpl(`${config.ai.openaiBaseUrl}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.ai.openaiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      last = new Error(`OpenAI ${res.status}: ${text.slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    tin += data.usage?.input_tokens ?? 0;
    tout += data.usage?.output_tokens ?? 0;
    const msg = (data.output ?? []).find((o: any) => o.type === "message");
    const part = msg?.content?.find((c: any) => c.type === "output_text");
    if (!part?.text) {
      const refusal = msg?.content?.find((c: any) => c.type === "refusal");
      if (refusal) throw new Error(`Model refused: ${String(refusal.refusal).slice(0, 200)}`);
      throw new Error(data.status === "incomplete" ? `Model stopped early (${data.incomplete_details?.reason ?? "incomplete"})` : "Model returned no text");
    }
    try {
      return { raw: JSON.parse(part.text), tokensIn: tin, tokensOut: tout, model: data.model ?? model, repaired };
    } catch (e) {
      if (repaired) throw new Error(`Invalid JSON after one repair attempt: ${(e as Error).message}`);
      repaired = true;
      body = repairBody(model, call, schema, part.text, (e as Error).message);
    }
  }
  throw last ?? new Error("Model call failed");
}

async function audit(row: { purpose: string; model: string; via: string; inputHash: string; outputHash: string; tokensIn: number; tokensOut: number; costUsd: number; latencyMs: number; ok: boolean; error: string | null; output: unknown; runId: string | null }): Promise<number | null> {
  try {
    const db = await getDb();
    const r = await db.query<{ id: number }>(
      `INSERT INTO ai_calls (purpose, model, via, input_hash, output_hash, tokens_in, tokens_out, cost_usd, latency_ms, ok, error, output, run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [row.purpose, row.model, row.via, row.inputHash, row.outputHash, row.tokensIn, row.tokensOut, row.costUsd, row.latencyMs, row.ok, row.error, row.ok ? JSON.stringify(row.output) : null, row.runId],
    );
    return r.rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function replay(inputHash: string): Promise<{ output: unknown; model: string } | null> {
  try {
    const db = await getDb();
    const r = await db.query<{ output: unknown; model: string }>("SELECT output, model FROM ai_calls WHERE input_hash = $1 AND ok AND via <> 'replay' ORDER BY id DESC LIMIT 1", [inputHash]);
    return r.rows[0] ?? null;
  } catch {
    return null;
  }
}

/** One structured call through the chain. Throws NoModelError when no model is configured or every step failed. */
export async function structured<T>(call: StructuredCall<T>): Promise<CallResult<T>> {
  assertSafeSchema(call.schema);
  const schema = strictify(call.schema);
  const inputHash = hashInput(call);
  const parse = call.parse ?? ((x: unknown) => x as T);
  const started = Date.now();
  if (!hasOpenAI()) {
    if (call.allowReplay === true) {
      const r = await replay(inputHash);
      if (r) return { output: parse(r.output), model: r.model, via: "replay", inputHash, tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: Date.now() - started, auditId: null };
    }
    throw new NoModelError("AI_PROVIDER is not openai or OPENAI_API_KEY is unset");
  }
  const chain = call.model ? [call.model] : chainFor(call.tier);
  const errors: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    const t0 = Date.now();
    try {
      const r = await openaiStructured(model, call, schema);
      const output = parse(r.raw);
      const latencyMs = Date.now() - t0;
      const costUsd = estimateCost(r.model, r.tokensIn, r.tokensOut);
      const via = i === 0 ? "primary" : "fallback";
      const auditId = await audit({ purpose: call.purpose, model: r.model, via, inputHash, outputHash: createHash("sha256").update(JSON.stringify(r.raw)).digest("hex"), tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd, latencyMs, ok: true, error: null, output: r.raw, runId: call.runId ?? null });
      return { output, model: r.model, via, inputHash, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd, latencyMs, auditId };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      errors.push(`${model}: ${msg}`);
      await audit({ purpose: call.purpose, model, via: i === 0 ? "primary" : "fallback", inputHash, outputHash: "", tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: Date.now() - t0, ok: false, error: msg, output: null, runId: call.runId ?? null });
    }
  }
  if (call.allowReplay === true) {
    const r = await replay(inputHash);
    if (r) {
      await audit({ purpose: call.purpose, model: r.model, via: "replay", inputHash, outputHash: "", tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: Date.now() - started, ok: true, error: null, output: r.output, runId: call.runId ?? null });
      return { output: parse(r.output), model: r.model, via: "replay", inputHash, tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: Date.now() - started, auditId: null };
    }
  }
  throw new NoModelError(`Every model failed: ${errors.join(" | ")}`);
}

/** Summary for the evidence page. */
export async function aiUsageSummary(): Promise<{ calls: number; ok: number; cost_usd: number; by_purpose: { purpose: string; calls: number; cost_usd: number; p50_ms: number; replayed: number }[] }> {
  const db = await getDb();
  const tot = (await db.query<{ calls: string; ok: string; cost: string }>("SELECT count(*) AS calls, count(*) FILTER (WHERE ok) AS ok, coalesce(sum(cost_usd),0) AS cost FROM ai_calls")).rows[0];
  const by = (await db.query<{ purpose: string; calls: string; cost: string; p50: string; replayed: string }>("SELECT purpose, count(*) AS calls, coalesce(sum(cost_usd),0) AS cost, coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms),0) AS p50, count(*) FILTER (WHERE via = 'replay') AS replayed FROM ai_calls WHERE ok GROUP BY purpose ORDER BY purpose")).rows;
  return {
    calls: Number(tot?.calls ?? 0),
    ok: Number(tot?.ok ?? 0),
    cost_usd: Number(tot?.cost ?? 0),
    by_purpose: by.map((r) => ({ purpose: r.purpose, calls: Number(r.calls), cost_usd: Number(r.cost), p50_ms: Math.round(Number(r.p50)), replayed: Number(r.replayed) })),
  };
}
