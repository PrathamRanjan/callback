import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { getDb } from "../src/db.js";
import { askTools, startAsk, WRITE_TOOLS } from "../src/agent/ask.js";
import { agentLoop, groundAnswer, LOOP_LIMITS } from "../src/ai/loop.js";
import { setProviderFetch } from "../src/ai/provider.js";
import { callPayPalRead, PAYPAL_MCP_READ } from "../src/paypal/mcp.js";
import { createApp } from "../src/app.js";
import { Client } from "./client.js";
import { freshWorld } from "./setup.js";

// Spec A5.3: the agent loop with visible work. No tool moves money; every step is a trace row; answers are grounded.
const saved = { provider: config.ai.provider, key: config.ai.openaiKey };
afterEach(() => {
  setProviderFetch(null);
  Object.assign(config.ai, saved);
});
const useModel = () => Object.assign(config.ai, { provider: "openai", openaiKey: "test-key" });
/** A fake Responses API. Each reply is a list of tool calls (name, args) or a final answer. */
function script(replies: ({ calls: [string, Record<string, unknown>][] } | { answer: { text: string; cites: string[] }[] })[]) {
  const bodies: any[] = [];
  let n = 0;
  setProviderFetch((async (_u: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    const r = replies.shift() ?? { calls: [["get_plan", {}]] as [string, Record<string, unknown>][] };
    const output = "calls" in r ? r.calls.map(([name, a]) => ({ type: "function_call", call_id: `c${++n}`, name, arguments: JSON.stringify(a) })) : [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ sentences: r.answer }) }] }];
    return new Response(JSON.stringify({ model: "gpt-6.1-sol", status: "completed", output, usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200 });
  }) as typeof fetch);
  return bodies;
}

describe("the agent's tools", () => {
  it("contain no tool that writes: Callback read tools, PayPal read tools and propose_ tools only", async () => {
    const { db, seeded } = await freshWorld();
    const t = await askTools(seeded.business.id, "run_test", db);
    const names = t.tools.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["get_plan", "list_due", "customer_record", "consent_record", "get_policy", "propose_skip_call"]));
    for (const w of WRITE_TOOLS) expect(names).not.toContain(w);
    for (const x of t.tools) {
      if (x.source === "paypal") expect(PAYPAL_MCP_READ as readonly string[]).toContain(x.name.replace(/^paypal_/, ""));
      if (x.source === "propose") expect(x.name).toMatch(/^propose_/);
    }
    expect(names.filter((n) => !n.startsWith("propose_") && !n.startsWith("paypal_")).some((n) => /refund|capture|charge|pay|create|send|decide|place|skip|draft|update|delete/.test(n))).toBe(false);
    expect(t.notes.join(" ")).toMatch(/isn't configured/); // tests never reach PayPal's real server
    await t.close();
  });
  it("the PayPal allowlist names no write, and anything else is refused before it is sent", async () => {
    for (const n of PAYPAL_MCP_READ) expect(n).toMatch(/^(get|list|show)_/);
    await expect(callPayPalRead("create_refund", {})).rejects.toThrow(/not a read-only PayPal tool/);
    await expect(callPayPalRead("pay_order", {})).rejects.toThrow(/not a read-only PayPal tool/);
  });
  it("the loop engine imports nothing that can move money", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "ai", "loop.ts"), "utf8");
    expect(src).not.toMatch(/from "\.\.\/(paypal|services|guard|voice|mcp|agent)/);
  });
});

describe("the loop", () => {
  it("calls tools, records every step, and answers with sentences that cite them", async () => {
    const { seeded } = await freshWorld();
    useModel();
    const bodies = script([{ calls: [["get_plan", {}], ["list_due", {}]] }, { answer: [{ text: "Priya owes a $60 deposit.", cites: ["F1"] }, { text: "There are open items.", cites: ["F2", "F9"] }] }]);
    const { runId, done } = await startAsk(seeded.business.id, "Who will you call today?", "test");
    await done;
    const db = await getDb();
    const steps = (await db.query<any>("SELECT tool, result FROM agent_trace WHERE run_id = $1 ORDER BY step", [runId])).rows.map((r) => ({ tool: r.tool, result: typeof r.result === "string" ? JSON.parse(r.result) : r.result }));
    const tools = steps.filter((s) => s.tool === "ask.tool");
    expect(tools.map((s) => s.result.name)).toEqual(["get_plan", "list_due"]);
    expect(tools.every((s) => s.result.ok && s.result.summary.length > 0)).toBe(true);
    const ans = steps.find((s) => s.tool === "ask.answer")!.result;
    expect(ans.sentences[0]).toEqual({ text: "Priya owes a $60 deposit.", cites: ["F1"] });
    expect(ans.sentences[1].cites).toEqual(["F2"]); // F9 never existed
    expect(bodies[0].tools.map((t: any) => t.name)).toContain("consent_record");
    expect(bodies[1].input.some((i: any) => i.type === "function_call_output" && i.output.startsWith("F1 (get_plan)"))).toBe(true);
    expect((await db.query<any>("SELECT status FROM agent_runs WHERE id = $1", [runId])).rows[0].status).toBe("done");
  });
  it("code removes a sentence whose amount is in none of the facts it cites", () => {
    const facts = new Map([["F1", '{"balance": 60}']]);
    const g = groundAnswer([{ text: "Priya owes $60.", cites: ["F1"] }, { text: "Give her $45 off.", cites: ["F1"] }], facts);
    expect(g.removed).toBe(1);
    expect(g.sentences[1].text).toBe("");
    expect(g.sentences[1].removed).toMatch(/\$45/);
  });
  it("a proposal is only a row for the owner: nothing is skipped", async () => {
    const { db, seeded } = await freshWorld();
    useModel();
    const call = (await db.query<any>("SELECT id FROM calls WHERE status = 'planned' LIMIT 1")).rows[0].id;
    script([{ calls: [["propose_skip_call", { call_id: call, reason: "test" }]] }, { answer: [{ text: "I proposed skipping it.", cites: ["F1"] }] }]);
    await (await startAsk(seeded.business.id, "Should we skip this one?", "test")).done;
    expect((await db.query<any>("SELECT status FROM calls WHERE id = $1", [call])).rows[0].status).toBe("planned");
    expect((await db.query<any>("SELECT kind, status FROM proposals")).rows).toEqual([{ kind: "skip_call", status: "open" }]);
  });
  it("stops after eight model steps with an honest message", async () => {
    await freshWorld();
    useModel();
    script([]);
    const events: any[] = [];
    const r = await agentLoop({ system: "s", question: "q", tools: [{ name: "get_plan", description: "", parameters: { type: "object", properties: {} }, source: "callback", run: async () => "{}" }], onEvent: async (e) => void events.push(e) });
    expect(r.ok).toBe(false);
    expect(events.filter((e) => e.kind === "model").length).toBe(LOOP_LIMITS.maxSteps);
    expect(events.at(-1).message).toMatch(/eight steps/);
  });
  it("with no model, Ask refuses honestly and nothing is answered by rules", async () => {
    await freshWorld();
    Object.assign(config.ai, { provider: "rules" });
    const srv = createApp().listen(0);
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    const c = new Client(base);
    await c.post("/demo/signin-as", { role: "owner" });
    const r = await c.postJson("/api/app/ask", { question: "Who will you call?" });
    expect(r.status).toBe(503);
    expect(r.json.message).toMatch(/isn't available/);
    srv.close();
  });
});
