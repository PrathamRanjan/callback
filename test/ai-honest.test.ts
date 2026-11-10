import { afterEach, describe, expect, it } from "vitest";
import { AI_FAILED_LINE } from "../src/ai/agent.js";
import { requestBody, setProviderFetch } from "../src/ai/provider.js";
import { compilePolicy } from "../src/guard/policy.js";
import { config } from "../src/config.js";
import { customerSays, startCall } from "../src/services/calls.js";
import { callAttempts, callById } from "../src/store.js";
import { setPayPal } from "../src/paypal/index.js";
import { callFor, freshWorld, NOW } from "./setup.js";

// Spec A11, A5.4 and A5.5: no rules stand-in for a failed model, a repair attempt for broken JSON, a backup model
// when the guard rejects a line, and an honest stop the person can retry.
const saved = { provider: config.ai.provider, key: config.ai.openaiKey };
afterEach(() => {
  setProviderFetch(null);
  setPayPal(null);
  Object.assign(config.ai, saved);
});
const useModel = () => Object.assign(config.ai, { provider: "openai", openaiKey: "test-key" });
/** A fake Responses API: each call returns the next scripted text (or an HTTP status). */
function script(replies: (string | number)[]) {
  const bodies: any[] = [];
  setProviderFetch((async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    const r = replies.shift() ?? 500;
    if (typeof r === "number") return new Response("upstream down", { status: r });
    return new Response(JSON.stringify({ model: bodies.at(-1).model, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: r }] }], usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200 });
  }) as typeof fetch);
  return bodies;
}
const turn = (o: Record<string, unknown>) => JSON.stringify({ tool: "none", option_id: null, outcome: null, reason: "test", ...o });

describe("honest AI failure", () => {
  it("requests carry a 4,000-token cap and low reasoning effort", () => {
    const b = requestBody("gpt-6.1-sol", { purpose: "turn", tier: "read", system: "s", parts: [], schemaName: "x", schema: {} }, {});
    expect(b.max_output_tokens).toBeGreaterThanOrEqual(4000);
    expect(b.reasoning).toEqual({ effort: "low" });
    expect(config.ai.models.read).toBe("gpt-6.1-sol");
    expect(config.ai.models.readBackup).toBe("gpt-6-sol");
  });

  it("with no model a call does not start, nothing is said, and it can be tried again", async () => {
    const { db, seeded } = await freshWorld();
    Object.assign(config.ai, { provider: "none", openaiKey: "" });
    const id = await callFor(db, seeded.obligations.priya_deposit);
    await expect(startCall(db, id, "simulator", "test")).rejects.toMatchObject({ code: "ai_unavailable" });
    const c = await callById(db, id);
    expect(c.status).toBe("planned");
    expect(c.transcript.length).toBe(0);
    await db.close();
  });

  it("broken JSON gets one repair attempt on the same model", async () => {
    const { db, seeded } = await freshWorld();
    useModel();
    const bodies = script(['{"say": "Hi Priya, unterminated', turn({ say: "Hi Priya, it's the studio. Is now a bad time?" })]);
    const id = await callFor(db, seeded.obligations.priya_deposit);
    const s = await startCall(db, id, "simulator", "test");
    expect(s.opening).toMatch(/^Hi Priya, it's the studio/);
    expect(bodies.length).toBe(2);
    expect(bodies[1].model).toBe(bodies[0].model);
    expect(bodies[1].instructions).toMatch(/not valid JSON/);
    expect(s.call.state.brain).toBe("model");
    await db.close();
  });

  it("a line with an invented amount goes to the backup model, never to rules", async () => {
    const { db, seeded } = await freshWorld();
    useModel();
    const id = await callFor(db, seeded.obligations.priya_deposit);
    const bodies = script([turn({ say: "Hi Priya, calling about your booking." }), turn({ say: "I can do it for $5 today." }), turn({ say: "I can't change the amount, but I can text you the link." })]);
    await startCall(db, id, "simulator", "test");
    const r = await customerSays(db, id, "Can you do it for five dollars?");
    expect(bodies.map((b) => b.model)).toEqual([config.ai.models.read, config.ai.models.read, config.ai.models.readBackup]);
    expect(r.decision.brain).toBe("model");
    expect(r.say).not.toMatch(/\$5\b/);
    expect(r.decision.reason).toMatch(/backup model/);
    await db.close();
  });

  it("a model failure mid-call ends it with a fixed line, labelled, and it does not use up the day's attempt", async () => {
    const { db, seeded } = await freshWorld();
    useModel();
    const id = await callFor(db, seeded.obligations.priya_deposit);
    script([turn({ say: "Hi Priya, calling about your booking." }), 500, 500, 500, 500, 500, 500]);
    await startCall(db, id, "simulator", "test");
    const r = await customerSays(db, id, "Sure, what's this about?");
    expect(r.decision.brain).toBe("none");
    expect(r.say).toBe(AI_FAILED_LINE);
    const c = await callById(db, id);
    expect(c.status).toBe("ended");
    expect(c.outcome).toBe("ai_failed");
    expect(c.transcript.at(-1)?.text).toMatch(/AI model failed on this turn/);
    expect((await callAttempts(db, c.customer_id, NOW)).attempts_today).toBe(0);
    await db.close();
  });

  it("the policy reader says when the model failed and the draft cannot be adopted", async () => {
    Object.assign(config.ai, { provider: "none", openaiKey: "" });
    const c = await compilePolicy("Only call 10am to 6pm on weekdays. Never more than 10% off.");
    expect(c.ai_error).toBeTruthy();
    expect(c.rules.max_discount_pct).toBe(10); // code still reads the numbers
    useModel();
    script([500, 500, 500, 500, 500, 500]);
    expect((await compilePolicy("Only call 10am to 6pm.")).ai_error).toMatch(/OpenAI 500/);
  });
});
