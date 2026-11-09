import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { setPayPal } from "../src/paypal/index.js";
import { CASES, harnessContext, runAdversarial } from "../src/eval/adversarial.js";
import { personas, runPersonaSuite } from "../src/eval/personas.js";
import { callFor, freshWorld } from "./setup.js";
import { Client } from "./client.js";
import { DEMO_IMPERSONATION } from "../src/web/safety.js";
import { isFoundationRoute, serveTracked } from "./journey-coverage.js";

let world: Awaited<ReturnType<typeof freshWorld>>;
let srv: Awaited<ReturnType<typeof serveTracked>>;
let owner: Client;
let anon: Client;

beforeAll(async () => {
  world = await freshWorld();
  srv = await serveTracked(createApp());
  owner = new Client(srv.base);
  anon = new Client(srv.base);
  await owner.post("/login", { key: world.seeded.ownerKey, next: "/today" });
});
afterAll(async () => {
  await srv.close();
  setPayPal(null);
  await world.db.close();
});

async function mcp(client: Client, path: string, method: string, params: unknown, headers: Record<string, string> = {}) {
  const r = await client.postJson(path, { jsonrpc: "2.0", id: 1, method, params }, { accept: "application/json, text/event-stream", ...headers });
  return r;
}

describe("foundation routes", () => {
  it("traces: list, page, JSON, customer token scoping", async () => {
    const id = await callFor(world.db, world.seeded.obligations.priya_deposit);
    await owner.post(`/calls/${id}/place`);
    await owner.post(`/calls/${id}/say`, { text: "yes send it" });
    const runId = (await world.db.query<{ run_id: string }>("SELECT run_id FROM calls WHERE id = $1", [id])).rows[0].run_id;
    expect((await owner.get("/ops/traces")).text).toContain("Priya");
    expect((await owner.get(`/trace/${runId}`)).text).toContain("gate.charge");
    expect((await owner.get(`/api/v1/runs/${runId}`)).json.steps.length).toBeGreaterThan(3);
    expect(Array.isArray((await owner.get("/api/v1/runs")).json)).toBe(true);
    expect((await anon.get(`/api/v1/runs/${runId}`)).status).toBe(401);
    expect((await owner.get("/trace/nope")).status).toBe(404);
    // Customer token: Priya can see her run; Lena cannot (demo mode off for this check).
    const { config } = await import("../src/config.js");
    const prev = config.demoMode;
    (config as any).demoMode = false;
    expect((await anon.get(`/trace/${runId}?token=${world.seeded.customers.priya.token}`)).status).toBe(200);
    expect((await anon.get(`/trace/${runId}?token=${world.seeded.customers.lena.token}`)).status).toBe(403);
    (config as any).demoMode = prev;
  });
  it("eval explorer: adversarial run, persona quick run, chips, csv, markdown", async () => {
    expect((await owner.get("/ops/eval")).text).toContain("Not run yet");
    expect(decodeURIComponent((await owner.post("/ops/eval/run", { suite: "adversarial" })).location ?? "")).toMatch(new RegExp(`${CASES.length}/${CASES.length} attacks blocked`));
    const adv = await owner.get("/ops/eval?suite=adversarial&trap=consent");
    expect(adv.text).toContain("consent-dnc");
    expect(adv.text).not.toContain("kill-global");
    expect(decodeURIComponent((await owner.post("/ops/eval/run", { suite: "personas", limit: "3" })).location ?? "")).toMatch(/6 persona runs/);
    const ev = await owner.get("/ops/eval?suite=personas&arm=rules&outcome=correct");
    expect(ev.status).toBe(200);
    expect(ev.text).toContain('class="chip on"');
    const csv = await owner.get("/ops/eval.csv?suite=personas");
    expect(csv.headers.get("content-type")).toMatch(/csv/);
    expect(csv.text.split("\n").length).toBeGreaterThan(3);
    expect((await owner.get("/ops/eval/personas.md")).text).toContain("# Persona evals");
    expect((await owner.get("/ops/eval/adversarial.md")).text).toContain("# Adversarial harness");
  }, 60_000);
  it("money desk, read-back, negative paths, webhook endpoint", async () => {
    const m = await owner.get("/ops/money");
    expect(m.status).toBe(200);
    expect(m.text).toContain("Pay links");
    expect((await owner.post("/ops/money/readback")).location).toMatch(/ok=/);
    for (const c of ["capture_declined", "order_voided", "refund_422", "invoice_404"]) expect((await owner.post("/ops/money/negative", { case: c })).location).toMatch(/ok=/);
    expect((await owner.post("/ops/money/webhook/simulate", { event: "PAYMENT.CAPTURE.COMPLETED" })).location).toMatch(/err=/);
    const wh = await anon.postJson("/webhooks/paypal", { id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP" } });
    expect(wh.status).toBe(202);
    expect(wh.json.verified).toBe(false);
    expect((await world.db.query("SELECT * FROM webhook_events")).rows).toHaveLength(1);
  });
  it("channels: simulator, approval by button, STOP by sms, telegram and whatsapp webhooks", async () => {
    expect((await owner.get("/ops/channels")).text).toContain("Connect Telegram");
    const conn = await owner.post("/connect/telegram");
    expect(conn.location).toMatch(/t\.me\/.+start=callback-/);
    expect(decodeURIComponent((await owner.post("/ops/channels/reply", { address: `owner:${world.seeded.business.id}`, text: "pending?" })).location ?? "")).toMatch(/pending approval/);
    const tg = await anon.postJson("/webhooks/telegram", { message: { chat: { id: 42 }, text: "hello" } });
    expect(tg.json.ok).toBe(true);
    expect((await anon.postJson("/webhooks/telegram", { callback_query: { data: "m1:approve:nope", message: { chat: { id: 42 } } } })).json.ok).toBe(true);
    expect((await anon.get("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=callback-verify&hub.challenge=abc")).text).toBe("abc");
    expect((await anon.get("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong")).status).toBe(403);
    expect((await anon.postJson("/webhooks/whatsapp", { entry: [{ changes: [{ value: { messages: [{ type: "text", from: "61400", text: { body: "hi" } }] } }] }] })).json.ok).toBe(true);
    const sms = await anon.req("POST", "/webhooks/sms", { form: { From: "+61 400 111 222", Body: "STOP" } });
    expect(sms.status).toBe(200);
    const priya = (await world.db.query<{ dnc: boolean }>("SELECT dnc FROM customers WHERE id = $1", [world.seeded.customers.priya.id])).rows[0];
    expect(priya.dnc).toBe(true);
    expect((await owner.get(`/ops/channels?address=${encodeURIComponent("+61 400 111 222")}`)).text).toContain("removed from calls");
  });
  it("pwa, push, evidence, judge, llms, skill, mcp page", async () => {
    expect((await anon.get("/manifest.webmanifest")).json.name).toBe("Callback");
    expect((await anon.get("/sw.js")).text).toContain("callback-v1");
    expect((await anon.get("/push/public-key")).json.key).toBeNull();
    expect((await anon.postJson("/push/subscribe", { endpoint: "x" })).status).toBe(401);
    expect((await owner.postJson("/push/subscribe", { endpoint: "x" })).json.subscribed).toBe(true);
    const ev = await owner.get("/ops/evidence");
    expect(ev.status).toBe(200);
    expect(ev.text).toContain("attacks blocked");
    expect(ev.text).toContain("Policy backtest");
    const j = await anon.get("/judge");
    expect(j.status).toBe(200);
    expect(anon.cookies.has("cb_judge")).toBe(true);
    expect((await anon.get("/judge?beat=4")).text).toContain("The evidence");
    expect((await anon.get("/llms.txt")).text).toContain("Owner MCP");
    const sk = await anon.get("/skill.md");
    expect(sk.text).toContain("name: callback");
    expect(sk.text).not.toContain("{APP_URL}");
    expect((await owner.get("/ops/mcp")).text).toContain("Owner server");
  });
  it("owner MCP: tools list, get_plan, draft_policy, decide_approval; customer MCP", async () => {
    expect((await mcp(anon, "/mcp", "tools/list", {})).status).toBe(401);
    const list = await mcp(anon, "/mcp", "tools/list", {}, { authorization: `Bearer ${world.seeded.ownerKey}` });
    expect(list.status).toBe(200);
    const names = list.json.result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_plan", "place_call", "draft_policy", "decide_approval", "get_guard", "get_trace"]));
    const plan = await mcp(anon, "/mcp", "tools/call", { name: "get_plan", arguments: {} }, { authorization: `Bearer ${world.seeded.ownerKey}` });
    const rows = JSON.parse(plan.json.result.content[0].text);
    expect(rows.some((r: any) => r.callable === false && r.blocked_because.length)).toBe(true);
    const draft = await mcp(anon, "/mcp", "tools/call", { name: "draft_policy", arguments: { text: "Call 10am to 3pm weekdays, up to 5% off." } }, { authorization: `Bearer ${world.seeded.ownerKey}` });
    const d = JSON.parse(draft.json.result.content[0].text);
    expect(d.rules.max_discount_pct).toBe(5);
    expect(d.backtest.cases).toBeGreaterThan(10);
    const guard = await mcp(anon, "/mcp", "tools/call", { name: "get_guard", arguments: {} }, { authorization: `Bearer ${world.seeded.ownerKey}` });
    expect(JSON.parse(guard.json.result.content[0].text).audit.ok).toBe(true);
    const badCall = await mcp(anon, "/mcp", "tools/call", { name: "get_call", arguments: { call_id: "nope" } }, { authorization: `Bearer ${world.seeded.ownerKey}` });
    expect(badCall.json.result.isError).toBe(true);
    const calls = JSON.parse((await mcp(anon, "/mcp", "tools/call", { name: "list_calls", arguments: { status: "planned" } }, { authorization: `Bearer ${world.seeded.ownerKey}` })).json.result.content[0].text);
    const planned = calls[0];
    const skip = await mcp(anon, "/mcp", "tools/call", { name: "skip_call", arguments: { call_id: planned.id, reason: "mcp test" } }, { authorization: `Bearer ${world.seeded.ownerKey}` });
    expect(JSON.parse(skip.json.result.content[0].text).skipped).toBe(true);
    // Customer MCP
    const tok = world.seeded.customers.lena.token;
    const cl = await mcp(anon, `/c/${tok}/mcp`, "tools/list", {});
    expect(cl.json.result.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["my_account", "get_pay_link", "stop_calls"]));
    const acct = JSON.parse((await mcp(anon, `/c/${tok}/mcp`, "tools/call", { name: "my_account", arguments: {} })).json.result.content[0].text);
    expect(acct.items.length).toBeGreaterThan(0);
    const link = await mcp(anon, `/c/${tok}/mcp`, "tools/call", { name: "get_pay_link", arguments: { obligation_id: acct.items[0].id } });
    expect(JSON.parse(link.json.result.content[0].text).amount).toBe(180);
    expect((await mcp(anon, "/c/nope/mcp", "tools/list", {})).status).toBe(404);
    expect((await anon.get("/mcp")).status).toBe(401);
  });
  it("personas and adversarial suites at module level", async () => {
    expect(personas().length).toBe(60);
    const ctx = (await harnessContext(world.db))!;
    const res = await runAdversarial(ctx, world.db);
    expect(res.filter((r) => !r.caught).map((r) => `${r.id}: ${JSON.stringify(r.detail)}`)).toEqual([]);
    const out = await runPersonaSuite(["rules", "oracle"], 5);
    expect(out.filter((r) => r.arm === "rules").every((r) => r.breaches === 0)).toBe(true);
  }, 60_000);
  it("safety: the owner's page, the model card, a scan of the demo impersonation, protected mode on and off", async () => {
    expect((await owner.get("/safety")).text).toMatch(/Verify code/);
    expect((await owner.get("/safety/model-card")).text).toMatch(/ScamShield/);
    const scan = await owner.req("POST", "/safety/scan", { json: { text: DEMO_IMPERSONATION } });
    expect(scan.status).toBe(200);
    expect(JSON.parse(scan.text).rule).toBe("owner_impersonation");
    expect((await owner.post("/safety/protected", { on: "1" })).status).toBe(302);
    expect((await owner.get("/safety")).text).toMatch(/Turn protected mode off/);
    expect((await owner.post("/safety/protected", { on: "0" })).status).toBe(302);
  });
  it("every foundation route was walked and nothing returned 5xx", () => {
    expect(srv.failures).toEqual([]);
    const missed = srv.missed((r) => !isFoundationRoute(r) || /sms|voice|ops\/guard/.test(r));
    expect(missed).toEqual([]);
  });
});
