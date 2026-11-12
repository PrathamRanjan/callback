/**
 * "Ask Callback" (spec A5.3, B2 "AI work"): the owner asks in plain words; the agent loop answers with visible work.
 * Tools, and nothing else:
 *  (a) the read-only tools of Callback's own owner MCP server, reached in-process over an in-memory MCP transport, so
 *      the agent uses exactly what an outside MCP client gets, filtered to tools marked readOnlyHint;
 *  (b) PayPal's hosted MCP server, read tools only (src/paypal/mcp.ts);
 *  (c) propose_* tools that write a proposal row for the owner and return its id.
 * No tool places a call, decides an approval, changes rules or moves money; test/agent-loop.test.ts checks the list.
 * Each step is a row in agent_trace, which the browser streams over server-sent events.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Queryable } from "../db.js";
import { getDb } from "../db.js";
import { agentLoop, type LoopEvent, type LoopTool } from "../ai/loop.js";
import { buildOwnerServer } from "../mcp/tools.js";
import { callPayPalRead, paypalReadTools } from "../paypal/mcp.js";
import { newId } from "../lib/ids.js";
import { bizById, callById, nowOf } from "../store.js";
import { startRun } from "../trace.js";
import { answerIn, type Lang } from "../lib/lang.js";

/** Tool names that change something. None may ever be handed to the agent. */
export const WRITE_TOOLS = ["place_call", "skip_call", "decide_approval", "draft_policy"];

async function callbackReadTools(businessId: string): Promise<{ tools: LoopTool[]; close: () => Promise<void> }> {
  const server = buildOwnerServer(businessId, "ask-agent");
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "callback-ask", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const listed = (await client.listTools()).tools;
  const tools = listed
    .filter((t) => t.annotations?.readOnlyHint === true && !WRITE_TOOLS.includes(t.name))
    .map<LoopTool>((t) => ({
      name: t.name,
      description: t.description ?? "",
      parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
      source: "callback",
      run: async (args) => {
        const r: any = await client.callTool({ name: t.name, arguments: args });
        const text = (r.content ?? []).map((c: any) => c.text ?? "").join("\n");
        if (r.isError) throw new Error(text.slice(0, 300));
        return text;
      },
    }));
  return { tools, close: async () => void (await client.close().catch(() => undefined)) };
}

function proposeTools(businessId: string, runId: string, q: Queryable): LoopTool[] {
  const save = async (kind: string, payload: Record<string, unknown>, reason: string) => {
    const id = newId("prop");
    await q.query("INSERT INTO proposals (id, business_id, kind, payload, reason, run_id) VALUES ($1,$2,$3,$4,$5,$6)", [id, businessId, kind, JSON.stringify(payload), reason.slice(0, 300), runId]);
    return `Proposal ${id} saved for the owner to decide. Nothing has been done yet.`;
  };
  const callArg = { type: "object", properties: { call_id: { type: "string" }, reason: { type: "string" } }, required: ["call_id", "reason"] };
  return [
    {
      name: "propose_skip_call", source: "propose", parameters: callArg,
      description: "Propose that the owner skips one planned call, with the reason. Creates a proposal only; the call is not skipped.",
      run: async (a) => {
        const c = await callById(q, String(a.call_id), businessId);
        if (c.status !== "planned") return `Call ${c.id} is ${c.status}, not planned; nothing to propose.`;
        return save("skip_call", { call_id: c.id }, String(a.reason ?? ""));
      },
    },
    {
      name: "propose_call_now", source: "propose", parameters: callArg,
      description: "Propose that the owner places one planned call now. Creates a proposal only; consent and hours are re-checked in code when the owner places it.",
      run: async (a) => {
        const c = await callById(q, String(a.call_id), businessId);
        if (c.status !== "planned") return `Call ${c.id} is ${c.status}, not planned; nothing to propose.`;
        return save("call_now", { call_id: c.id }, String(a.reason ?? ""));
      },
    },
    {
      name: "propose_policy_change", source: "propose", parameters: { type: "object", properties: { text: { type: "string", description: "The new policy sentence in plain words" }, reason: { type: "string" } }, required: ["text", "reason"] },
      description: "Propose a change to the owner's call policy in plain words. The owner reviews the compiled rules and the backtest before anything changes.",
      run: async (a) => save("policy_change", { text: String(a.text ?? "").slice(0, 1000) }, String(a.reason ?? "")),
    },
  ];
}

/** Every tool the Ask agent gets, for one business. PayPal's tools are left out (and said so) when its server is down. */
export async function askTools(businessId: string, runId: string, q: Queryable): Promise<{ tools: LoopTool[]; notes: string[]; close: () => Promise<void> }> {
  const notes: string[] = [];
  const cb = await callbackReadTools(businessId);
  let pp: LoopTool[] = [];
  try {
    pp = (await paypalReadTools()).map<LoopTool>((t) => ({ name: `paypal_${t.name}`, description: `PayPal (read only): ${t.description}`, parameters: t.inputSchema ?? { type: "object", properties: {} }, source: "paypal", run: (args) => callPayPalRead(t.name, args) }));
    if (!pp.length) notes.push("PayPal's MCP server isn't configured here, so PayPal's own records weren't available.");
  } catch (e) {
    notes.push(`PayPal's MCP server didn't answer (${(e as Error).message.slice(0, 80)}), so PayPal's own records weren't available.`);
  }
  return { tools: [...cb.tools, ...pp, ...proposeTools(businessId, runId, q)], notes, close: cb.close };
}

/** What the rail shows is for people: email addresses (a sandbox buyer's login name, a customer's address) are masked. */
export const maskEmails = (t: string) => t.replace(/([\w.+-])[\w.+-]*@([\w-]+(?:\.[\w-]+)+)/g, "$1•••@$2");

const asks = new Map<string, number[]>();
export function allowAsk(key: string, max = 20): boolean {
  const now = Date.now();
  const xs = (asks.get(key) ?? []).filter((t) => now - t < 3600_000);
  if (xs.length >= max) return false;
  xs.push(now);
  asks.set(key, xs);
  return true;
}

export const ASK_PRESETS = [
  "Who will you call today, who won't you call, and why?",
  "Which money is most at risk this week, and what would you do about it?",
  "Has PayPal confirmed the payments from yesterday's calls?",
];

/** Start an Ask run. Returns at once with the run id; the loop keeps writing steps in the background. */
export async function startAsk(businessId: string, question: string, by: string, lang: Lang = "en"): Promise<{ runId: string; done: Promise<void> }> {
  const db = await getDb();
  const run = await startRun({ actor: "agent", agentId: "ask", subject: question.slice(0, 200), entity: "ask", entityId: businessId }, db);
  await run.step({ actor: "owner", tool: "ask.question", args: { question: question.slice(0, 2000), by } });
  const done = (async () => {
    let close = async () => undefined as void;
    try {
      const biz = await bizById(db, businessId);
      const now = await nowOf(db, businessId);
      const t = await askTools(businessId, run.id, db);
      close = t.close;
      for (const n of t.notes) await run.step({ actor: "system", tool: "ask.note", result: { note: n } });
      await run.step({ actor: "system", tool: "ask.tools", result: { tools: t.tools.map((x) => ({ name: x.name, source: x.source })) } });
      const system = `You are Callback's assistant for the owner of ${biz.name}, a studio that uses Callback to make its money calls (deposits, overdue invoices, cancelled classes). The studio's clock reads ${now.toISOString()} (time zone ${biz.tz}). Amounts in Callback's tools are in dollars.${lang !== "en" ? ` The owner may ask in English, Hindi, Indonesian or Brazilian Portuguese, or mix them. ${answerIn(lang)}` : ""}`;
      const onEvent = async (e: LoopEvent) => {
        if (e.kind === "model") await run.step({ actor: "model", tool: "ask.model", result: e, duration_ms: e.ms });
        else if (e.kind === "tool") await run.step({ actor: e.source === "paypal" ? "paypal" : e.source === "propose" ? "agent" : "code", tool: `ask.tool`, args: { name: e.name, args: e.args }, result: { fact: e.fact, name: e.name, source: e.source, ok: e.ok, args_summary: maskEmails(e.args_summary), summary: maskEmails(e.summary), output: maskEmails(e.output.slice(0, 1800)) }, duration_ms: e.ms });
        else if (e.kind === "answer") await run.step({ actor: "model", tool: "ask.answer", result: e });
        else await run.step({ actor: "system", tool: "ask.failed", result: e });
      };
      const r = await agentLoop({ system, question, tools: t.tools, onEvent, runId: run.id });
      await run.end(r.ok ? "done" : "failed");
    } catch (e) {
      if (!(await db.query("SELECT 1 FROM agent_trace WHERE run_id = $1 AND tool = 'ask.failed'", [run.id])).rows.length) await run.step({ actor: "system", tool: "ask.failed", result: { kind: "failed", message: "The AI couldn't finish this answer just now. Nothing was changed. Try again in a moment." } });
      await run.end("failed");
      console.error("ask failed:", (e as Error).message);
    } finally {
      await close();
    }
  })();
  return { runId: run.id, done };
}
