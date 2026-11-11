import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { createApp } from "../src/app.js";
import { setPayPal } from "../src/paypal/index.js";
import { callFor, freshWorld } from "./setup.js";
import { Client } from "./client.js";
import { isFoundationRoute, serveTracked } from "./journey-coverage.js";

let world: Awaited<ReturnType<typeof freshWorld>>;
let srv: Awaited<ReturnType<typeof serveTracked>>;
let owner: Client;
let staff: Client;
let anon: Client;

beforeAll(async () => {
  world = await freshWorld();
  const app = createApp();
  srv = await serveTracked(app);
  owner = new Client(srv.base);
  staff = new Client(srv.base);
  anon = new Client(srv.base);
});
afterAll(async () => {
  await srv.close();
  setPayPal(null);
  await world.db.close();
});

describe("journey: owner, staff, customer, demo, voice webhooks", () => {
  it("home, login, today, calls, customers, policy", async () => {
    expect((await anon.get("/")).status).toBe(200);
    expect((await anon.get("/healthz")).json.ok).toBe(true);
    expect((await anon.get("/login")).status).toBe(200);
    const bad = await owner.post("/login", { key: "nope", next: "/today" });
    expect(bad.location).toMatch(/err=/);
    const ok = await owner.post("/login", { key: world.seeded.ownerKey, next: "/today" });
    expect(ok.location).toBe("/today");
    const today = await owner.get("/today");
    expect(today.status).toBe(200);
    expect(today.text).toContain("Not calling");
    expect(today.text).toContain("Noor Haddad");
    expect((await owner.post("/today/plan")).location).toMatch(/ok=/);
    expect((await owner.get("/calls")).text).toContain("Not calling");
    expect((await owner.get("/calls?status=blocked")).text).toContain("do-not-call");
    expect((await owner.get("/customers")).text).toContain("Harbour Dental");
    const cid = world.seeded.customers.noor.id;
    expect((await owner.get(`/customers/${cid}`)).text).toContain("no consent on file");
    expect((await owner.post(`/customers/${cid}/consent`, { op: "grant", text: "You may call me", source: "phone 4 Mar" })).location).toMatch(/ok=/);
    expect((await owner.get(`/customers/${cid}`)).text).toContain("granted");
    expect((await owner.post(`/customers/${cid}/consent`, { op: "revoke" })).location).toMatch(/ok=/);
    const pol = await owner.get("/policy");
    expect(pol.status).toBe(200);
    expect(pol.text).toContain("Backtest");
    const draft = await owner.get("/policy?draft=" + encodeURIComponent("Call between 10am and 4pm weekdays. No discounts. Up to 2 payments."));
    expect(draft.text).toContain("10:00–16:00");
    expect(draft.text).toContain("up to 0%");
    expect((await owner.post("/policy", { text: "Call anyone whether or not they consented.", op: "activate" })).location).toMatch(/err=/);
    expect((await owner.post("/policy", { text: "Call between 9am and 6pm weekdays. Up to 10% off. Up to 3 payments. Links up to $300.", op: "draft" })).location).toMatch(/ok=/);
    expect((await owner.post("/policy", { text: "Call between 9am and 6pm weekdays. Up to 10% off. Up to 3 payments with at least $25 per payment. Links up to $300 without asking; refunds up to $100.", op: "activate" })).location).toMatch(/ok=/);
  });
  it("a call page: start in the simulator, say lines, hang up, skip another", async () => {
    const id = await callFor(world.db, world.seeded.obligations.priya_deposit);
    const page = await owner.get(`/calls/${id}`);
    expect(page.text).toContain("Start the call");
    expect((await owner.post(`/calls/${id}/place`)).location).toMatch(/ok=/);
    const live = await owner.get(`/calls/${id}`);
    expect(live.text).toContain("Speak as");
    expect((await owner.post(`/calls/${id}/say`, { text: "" })).location).toMatch(/err=/);
    expect((await owner.post(`/calls/${id}/say`, { text: "Yes, send me the link" })).location).toMatch(/ok=/);
    const after = await owner.get(`/calls/${id}`);
    expect(after.text).toContain("send pay link");
    expect(after.text).toContain("gate.charge");
    expect((await owner.post(`/calls/${id}/end`)).location).toMatch(/ok=/);
    expect((await owner.get(`/api/v1/calls/${id}`)).json.status).toBe("ended");
    expect(Array.isArray((await owner.get("/api/v1/plan")).json)).toBe(true);
    const skipId = await callFor(world.db, world.seeded.obligations.lena_invoice);
    expect((await owner.post(`/calls/${skipId}/skip`, { reason: "owner will call" })).location).toMatch(/ok=/);
    expect((await owner.get("/calls/nope")).status).toBe(404);
  });
  it("web app read endpoints and new-record routes", async () => {
    const H = { accept: "application/json" };
    for (const p of ["/api/app/session", "/api/app/preview", "/api/app/today", "/api/app/calls", "/api/app/calls?status=blocked", "/api/app/customers", "/api/app/policy", "/api/app/policy?draft=" + encodeURIComponent("Call 10am to 4pm weekdays."), "/api/app/guard", "/api/app/money", "/api/app/safety", "/api/app/messages", "/api/app/proof", "/api/app/evals?suite=adversarial", "/api/app/demo"]) {
      const r = await owner.get(p, H);
      expect(r.status, p).toBe(200);
    }
    const priya = world.seeded.customers.priya;
    expect((await owner.get(`/api/app/customers/${priya.id}`, H)).json.customer.name).toBe("Priya Natarajan");
    const call = (await owner.get("/api/app/calls", H)).json[0];
    expect((await owner.get(`/api/app/calls/${call.id}`, H)).json.call.id).toBe(call.id);
    const runs = (await owner.get("/api/app/proof", H)).json.runs;
    expect((await owner.get(`/api/app/trace/${runs[0].id}`, H)).json.steps.length).toBeGreaterThan(0);
    const mine = (await anon.get(`/api/app/c/${priya.token}`, H)).json;
    expect(mine.first_name).toBe("Priya");
    expect(JSON.stringify(mine)).not.toContain("Prefers texts"); // the owner's notes never reach the customer
    expect((await anon.get("/api/app/c/nope", H)).status).toBe(404);
    expect((await anon.get("/api/app/today", H)).status).toBe(401);
    const added = await owner.post("/customers", { name: "Ana Souza", phone: "+61 491 570 737", tz: "Australia/Brisbane", consent_text: "You may call me", consent_source: "front desk" });
    expect(added.location).toMatch(/ok=/);
    const anaId = added.location!.split("?")[0].split("/").pop()!;
    expect((await owner.post(`/customers/${anaId}/charges`, { kind: "invoice", title: "Invoice #3001: gait analysis", amount: "95", due_at: "2026-02-20T00:00:00Z" })).location).toMatch(/ok=.*95\.00/);
    const items = (await owner.get(`/api/app/customers/${anaId}`, H)).json.items;
    expect((await owner.post(`/obligations/${items[0].id}/cancel`, { reason: "flood" })).location).toMatch(/err=Only%20a%20paid%20booking/);
  });
  it("staff may see Today but not the owner pages", async () => {
    await staff.post("/login", { key: world.seeded.staffKey, next: "/today" });
    expect((await staff.get("/today")).status).toBe(200);
    const g = await staff.get("/ops/guard");
    expect(g.status).toBe(403);
    expect((await staff.post("/today/plan")).location).toMatch(/err=/);
    expect((await staff.post("/logout")).location).toBe("/");
  });
  it("guard: hold, approve, limits, kill, passkey start, audit", async () => {
    const id = await callFor(world.db, world.seeded.obligations.harbour_invoice);
    await owner.post(`/calls/${id}/place`);
    await owner.post(`/calls/${id}/say`, { text: "Sure, text me the link" });
    const guard = await owner.get("/ops/guard");
    expect(guard.text).toContain("Held for you");
    expect(guard.text).toContain("420.00");
    const apr = (await world.db.query<{ id: string }>("SELECT id FROM approvals WHERE status = 'pending'")).rows[0];
    expect((await owner.post(`/ops/guard/approvals/${apr.id}`, { op: "approve" })).location).toMatch(/ok=/);
    expect((await owner.post(`/ops/guard/approvals/${apr.id}`, { op: "approve" })).location).toMatch(/Already/);
    expect((await owner.post("/ops/guard/limits", { charge: "500", refund: "150", discount: "15" })).location).toMatch(/ok=/);
    expect((await owner.get("/ops/guard")).text).toContain('value="500"');
    expect((await owner.post("/ops/guard/kill", { scope: "action:refund", engaged: "1", reason: "test" })).location).toMatch(/ok=/);
    expect((await owner.get("/ops/guard")).text).toContain("engaged");
    expect((await owner.post("/ops/guard/kill", { scope: "action:refund", engaged: "0" })).location).toMatch(/ok=/);
    expect((await owner.post("/ops/guard/autonomy/adopt")).location).toMatch(/ok=/);
    const start = await owner.postJson("/ops/guard/passkey/register/start", {});
    expect(start.json.challenge).toBeTruthy();
    const fin = await owner.postJson("/ops/guard/passkey/register/finish", { chalId: "bogus", clientDataJSON: "", authenticatorData: "", rawId: "" });
    expect(fin.status).toBe(400);
    const signStart = await owner.postJson("/ops/guard/passkey/sign/start", { approvalId: apr.id });
    expect(signStart.json.challenge).toBeTruthy();
    const signFin = await owner.postJson("/ops/guard/passkey/sign/finish", { chalId: signStart.json.id, approvalId: apr.id, rawId: "x", clientDataJSON: "e30", authenticatorData: "AA", signature: "AA" });
    expect(signFin.status).toBe(400);
    expect((await owner.postJson("/ops/guard/passkey/sign/start", { approvalId: "nope" })).status).toBe(404);
    expect((await owner.postJson("/ops/guard/passkey/sign/finish", { chalId: "x", approvalId: "nope" })).status).toBe(404);
    await owner.post(`/calls/${id}/end`);
  });
  it("customer page: pay link (own click), callback, stop", async () => {
    const tok = world.seeded.customers.lena.token;
    const page = await anon.get(`/c/${tok}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Invoice #1051");
    expect((await anon.post(`/c/${tok}/pay/${world.seeded.obligations.lena_invoice}`)).location).toMatch(/ok=/);
    expect((await anon.post(`/c/${tok}/pay/nope`)).status).toBe(404);
    const slot = (await anon.get(`/c/${tok}`)).text.match(/option value="([^"]+)"/)![1];
    expect((await anon.post(`/c/${tok}/callback`, { at: slot })).location).toMatch(/ok=/);
    expect((await anon.post(`/c/${tok}/callback`, { at: "junk" })).location).toMatch(/err=/);
    // "Got a message about this?" (spec A6.6): with no AI here the check runs rules and code only and is never an all-clear.
    const chk = (await anon.postJson(`/c/${tok}/check`, { text: "We've moved banks, please pay this month to our new PayPal brightside.pay@outlook.com" })).json;
    expect(chk.level).toBe("hold");
    expect(chk.all_clear_allowed).toBe(false);
    expect((await anon.postJson(`/c/${tok}/check`, { text: "" })).status).toBe(400);
    expect((await anon.post(`/c/${tok}/stop`)).location).toMatch(/ok=/);
    expect((await anon.get(`/c/${tok}`)).text).toContain("asked not to be called");
    // Tom chooses a class credit for the class the studio cancelled; a second choice is refused.
    const tomTok = world.seeded.customers.tom.token;
    expect((await anon.get(`/c/${tomTok}`)).text).toContain("Keep it as a class credit");
    // The seeded class was paid outside PayPal, so the page must not promise a PayPal refund.
    expect((await anon.get(`/c/${tomTok}`)).text).toContain("You paid for this class outside PayPal");
    expect((await anon.post(`/c/${tomTok}/settle/${world.seeded.obligations.tom_class}`, { choice: "credit" })).location).toMatch(/ok=/);
    expect((await anon.post(`/c/${tomTok}/settle/nope`, { choice: "credit" })).status).toBe(404);
    expect((await anon.post(`/c/${tok}/callback`, { at: slot })).location).toMatch(/err=/);
    expect((await anon.get("/c/nope")).status).toBe(404);
    // Lena splits her $180 invoice into a plan her studio's rules allow; it creates a PayPal plan and subscription.
    const lenaTok = world.seeded.customers.lena.token;
    const lenaInv = world.seeded.obligations.lena_invoice;
    const lenaItem = (await anon.get(`/api/app/c/${lenaTok}`)).json.open.find((o: any) => o.id === lenaInv); const plans = lenaItem.plans;
    expect(plans.map((p: any) => p.id)).toEqual(["plan2", "plan3"]);
    expect((await anon.post(`/c/${lenaTok}/plan/${lenaInv}`, { option: "plan9" })).location).toMatch(/err=/);
    const made = await anon.post(`/c/${lenaTok}/plan/${lenaInv}`, { option: "plan3" });
    expect(made.location ?? "").toMatch(/ok=|paypal/);
    expect((await world.db.query<{ status: string }>("SELECT status FROM obligations WHERE id = $1", [lenaInv])).rows[0].status).toBe("planned");
    expect((await world.db.query("SELECT 1 FROM instalment_plans WHERE obligation_id = $1 AND subscription_id IS NOT NULL", [lenaInv])).rows).toHaveLength(1);
    expect((await anon.post(`/c/${lenaTok}/plan/${lenaInv}`, { option: "plan3" })).location).toMatch(/err=/);
    expect((await anon.post(`/c/${tomTok}/plan/${world.seeded.obligations.tom_class}`, { option: "plan2" })).status).toBe(404);
  });
  it("demo controls and persona run", async () => {
    expect((await anon.get("/demo")).status).toBe(200);
    expect((await owner.post("/demo/fault", { method: "createOrder", kind: "fail_503" })).location).toMatch(/ok=/);
    expect((await owner.post("/demo/fault", { method: "nope", kind: "fail_503" })).location).toMatch(/err=/);
    // The AI switch: owner only; armed, then turned off again so later steps here use the model as usual.
    expect(decodeURIComponent((await anon.post("/demo/fault-ai")).location ?? "")).toMatch(/err=Only the owner can make the AI fail/);
    expect(decodeURIComponent((await owner.post("/demo/fault-ai")).location ?? "")).toMatch(/ok=The AI now fails for 2 minutes/);
    expect((await world.db.query("SELECT 1 FROM demo_faults WHERE method = 'ai.model'")).rows.length).toBe(1);
    expect(decodeURIComponent((await owner.post("/demo/fault-ai", { off: "1" })).location ?? "")).toMatch(/ok=The AI is back on/);
    expect((await world.db.query("SELECT 1 FROM demo_faults WHERE method = 'ai.model'")).rows.length).toBe(0);
    expect((await owner.post("/demo/clock", { now: "2026-03-04T11:00:00Z" })).location).toMatch(/ok=/);
    expect((await owner.post("/demo/clock", { now: "2026-03-04T02:00:00Z" })).location).toMatch(/ok=/);
    expect((await owner.post("/demo/plan")).location).toMatch(/ok=/);
    const callId = await callFor(world.db, world.seeded.obligations.tom_invoice);
    const r = await owner.post("/demo/persona", { call: callId, persona: "haggler-chase_invoice-3" });
    expect(r.location).toMatch(/\/calls\//);
    const page = await owner.get(`/calls/${callId}`);
    expect(page.text).toContain("quarantined");
    expect((await owner.post("/demo/persona", { call: callId, persona: "nope" })).location).toMatch(/err=/);
    expect((await anon.post("/demo/persona", { call: callId, persona: "x" })).location).toBe("/login");
    // Replay a judge beat: Harbour's calls are cleared and a fresh call is planned for today.
    const again = await owner.post("/demo/call-again", { name: "Harbour" });
    expect(again.location).toMatch(/^\/calls\/call_.+ok=/);
    expect((await anon.post("/demo/call-again", { name: "Harbour" })).location).toMatch(/err=/);
    // Reset wipes everything, so a stranger is refused; a judge signs in as the owner with one button (demo mode) and may then reset.
    expect((await anon.post("/demo/reset", { pin: "1" })).location).toMatch(/err=Only/);
    expect((await anon.post("/demo/signin-as", { role: "staff" })).location).toBe("/calls");
    const judge = new Client(srv.base);
    expect((await judge.post("/demo/signin-as", { role: "owner" })).location).toBe("/today");
    // The shared studio (no private workspace) is reset only with the operator key, never by a visitor, even its owner.
    expect((await judge.post("/demo/reset", { pin: "1" })).location).toMatch(/err=Only/);
    (config as any).adminKey = "test-admin-key";
    expect((await judge.post("/demo/reset", { admin_key: "wrong" })).location).toMatch(/err=Only/);
    expect((await judge.post("/demo/reset", { admin_key: "test-admin-key" })).location).toMatch(/ok=Showcase/);
    (config as any).adminKey = "";
    expect((await judge.post("/demo/signin-as", { role: "owner" })).location).toBe("/today");
    const after = await judge.get("/demo");
    expect(after.text).toContain("Access keys (owner only");
    expect((await anon.get("/demo")).text).not.toContain("Access keys (owner only");
    const ownerKey = (await world.db.query<{ key_hash: string }>("SELECT key_hash FROM people WHERE role='owner'")).rows[0];
    expect(ownerKey).toBeTruthy();
    expect((await anon.post("/demo/signin", { key: "nope" })).location).toMatch(/err=/);
  });
  it("voice webhooks: TwiML opening, gather, status, generic events (demo mode accepts unsigned)", async () => {
    // After reset the world has new ids; re-login the owner with the new key is not possible (key not exposed), so use the db.
    const seededCall = (await world.db.query<{ id: string }>("SELECT id FROM calls WHERE status = 'planned' LIMIT 1")).rows[0];
    const { startCall } = await import("../src/services/calls.js");
    await startCall(world.db, seededCall.id, "phone", "test");
    const twiml = await anon.req("POST", `/webhooks/voice/twiml/${seededCall.id}`, { form: { CallSid: "CA1" } });
    expect(twiml.status).toBe(200);
    expect(twiml.text).toContain("<Gather");
    const g = await anon.req("POST", `/webhooks/voice/gather/${seededCall.id}`, { form: { SpeechResult: "Yes send me the link", Confidence: "0.9" } });
    expect(g.text).toContain("<Say");
    expect(g.text).toContain("PayPal link");
    const s = await anon.req("POST", `/webhooks/voice/status/${seededCall.id}`, { form: { CallStatus: "completed" } });
    expect(s.status).toBe(204);
    expect((await anon.postJson("/webhooks/voice/events", { provider: "vapi", type: "call.ended" })).status).toBe(202);
    const events = (await world.db.query<any>("SELECT kind, verified FROM voice_events ORDER BY at")).rows;
    expect(events.map((e: any) => e.kind)).toEqual(expect.arrayContaining(["twiml", "speech", "status:completed", "call.ended"]));
  });
  it("realtime session and tool routes refuse without a key / owner", async () => {
    const seededCall = (await world.db.query<{ id: string }>("SELECT id FROM calls ORDER BY created_at DESC LIMIT 1")).rows[0];
    expect((await anon.postJson(`/voice/realtime/session/${seededCall.id}`, {})).status).toBe(401);
    expect((await anon.postJson(`/calls/${seededCall.id}/tool`, { name: "send_pay_link" })).status).toBe(401);
    expect((await anon.postJson(`/calls/${seededCall.id}/speech`, { text: "hi" })).status).toBe(401);
  });
  it("live voice: a transcript is recorded only, and a repeated function call runs once (10 Nov 2026 regression)", async () => {
    const c = (await world.db.query<{ id: string }>("SELECT id FROM calls WHERE status = 'planned' AND purpose = 'confirm_deposit' LIMIT 1")).rows[0];
    expect(c).toBeTruthy();
    const judge = new Client(srv.base);
    expect((await judge.post("/demo/signin-as", { role: "owner" })).location).toBe("/today");
    const { startCall } = await import("../src/services/calls.js");
    await startCall(world.db, c.id, "simulator", "test");
    const runId = (await world.db.query<{ run_id: string }>("SELECT run_id FROM calls WHERE id = $1", [c.id])).rows[0].run_id;
    const steps = async (tool: string) => Number((await world.db.query<{ n: string }>("SELECT count(*) AS n FROM agent_trace WHERE run_id = $1 AND tool = $2", [runId, tool])).rows[0].n);
    const brains = async () => (await steps("brain.model")) + (await steps("brain.rules"));
    const opening = await brains(); // the opening line, from startCall
    // The customer's words: recorded, never decided on by the text brain (it used to send its own pay link).
    const sp = await judge.postJson(`/calls/${c.id}/speech`, { text: "Yes, please send me the link to pay the deposit." });
    expect(sp.status).toBe(200);
    expect(await steps("speech")).toBe(1);
    expect(await brains()).toBe(opening);
    expect(await steps("gate.charge")).toBe(0);
    expect((await judge.postJson(`/calls/${c.id}/speech`, { who: "agent", text: "I'll send the secure link now." })).status).toBe(200);
    // The same OpenAI function call reported twice runs once.
    const first = await judge.postJson(`/calls/${c.id}/tool`, { name: "send_pay_link", arguments: {}, call_id: "fc_test_1" });
    expect(first.json.ok).toBe(true);
    const again = await judge.postJson(`/calls/${c.id}/tool`, { name: "send_pay_link", arguments: {}, call_id: "fc_test_1" });
    expect(again.json.duplicate).toBe(true);
    expect(await steps("gate.charge")).toBe(1);
    const t = (await world.db.query<{ transcript: any[] }>("SELECT transcript FROM calls WHERE id = $1", [c.id])).rows[0].transcript;
    expect(t.map((x: any) => x.who)).toEqual(expect.arrayContaining(["customer", "agent"]));
    expect(t.some((x: any) => /live voice: tool call/.test(x.text))).toBe(false);
    expect(await steps("speech")).toBe(1); // the silent tool call adds no speech step
    // A transcript that lands just after the call ended is still kept, without reopening the finished run.
    expect((await judge.postJson(`/calls/${c.id}/tool`, { name: "end_call", arguments: { outcome: "paid_link" }, call_id: "fc_test_2" })).json.ended).toBe(true);
    expect((await judge.postJson(`/calls/${c.id}/speech`, { text: "Thanks, bye." })).json.ok).toBe(true);
    const after = (await world.db.query<{ transcript: any[]; run_id: string }>("SELECT transcript, run_id FROM calls WHERE id = $1", [c.id])).rows[0];
    expect(after.transcript.at(-1).text).toBe("Thanks, bye.");
    expect((await world.db.query<{ status: string }>("SELECT status FROM agent_runs WHERE id = $1", [after.run_id])).rows[0].status).not.toBe("running");
  });
  it("ask: a question streams its steps, and a proposal can be dismissed (spec A5.3)", async () => {
    const savedAi = { provider: config.ai.provider, key: config.ai.openaiKey };
    Object.assign(config.ai, { provider: "openai", openaiKey: "test-key" });
    const { setProviderFetch } = await import("../src/ai/provider.js");
    const planned = (await world.db.query<any>("SELECT id FROM calls WHERE status = 'planned' LIMIT 1")).rows[0]?.id;
    const replies = [
      [{ type: "function_call", call_id: "a1", name: "get_plan", arguments: "{}" }, { type: "function_call", call_id: "a2", name: "propose_skip_call", arguments: JSON.stringify({ call_id: planned, reason: "journey" }) }],
      [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ sentences: [{ text: "Here is the plan.", cites: ["F1"] }] }) }] }],
    ];
    setProviderFetch((async () => new Response(JSON.stringify({ model: "gpt-6.1-sol", output: replies.shift() ?? [], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 })) as typeof fetch);
    const owner = new Client(srv.base);
    expect((await owner.post("/demo/signin-as", { role: "owner" })).location).toBe("/today");
    try {
      const home = (await owner.get("/api/app/ask")).json;
      expect(home.presets.length).toBeGreaterThan(0);
      const r = await owner.postJson("/api/app/ask", { question: "Who will you call today?" });
      expect(r.status).toBe(200);
      const id = r.json.run_id;
      const stream = await owner.get(`/api/app/ask/${id}/stream`);
      expect(stream.text).toContain("event: end");
      expect(stream.text).toContain("ask.answer");
      const snap = (await owner.get(`/api/app/ask/${id}`)).json;
      expect(snap.steps.filter((s: any) => s.tool === "ask.tool").length).toBe(2);
      const prop = (await owner.get("/api/app/ask")).json.proposals[0];
      expect(prop.kind).toBe("skip_call");
      expect((await owner.postJson(`/api/app/ask/proposals/${prop.id}/dismiss`, {})).json.status).toBe("dismissed");
      expect((await staff.postJson("/api/app/ask", { question: "x" })).status).toBeGreaterThanOrEqual(401);
    } finally {
      setProviderFetch(null);
      Object.assign(config.ai, savedAi);
    }
  });

  it("the no-sign-in pages (spec A3.2) answer a stranger, and nothing on them is typed as live by hand", async () => {
    const stranger = new Client(srv.base);
    const j = (await stranger.get("/api/public/judge")).json;
    expect(j.paths.map((p: any) => p.id)).toEqual(["call", "refuse", "approve"]);
    expect(j.paths[0].steps.length).toBeGreaterThanOrEqual(3);
    expect(j.pages.map((p: any) => p.href)).toEqual(["/proof", "/ai", "/paypal", "/who-can-move-money", "/accessibility", "/agents"]);
    expect(j.live.find((r: any) => r.piece.startsWith("Phone calls")).live).toBe(false); // demo customers are never really rung
    expect(JSON.stringify(j)).not.toMatch(/@personal\.example\.com/); // no sandbox buyer login is printed unless the owner sets one for judges
    const proof = (await stranger.get("/api/public/proof")).json;
    expect(proof.eval.jobs.length).toBe(3);
    for (const job of proof.eval.jobs) for (const c of job.cases) expect(Object.keys(c).sort()).toEqual(["answer", "expected", "id", "input", "pass", "why"]);
    expect(proof.nightly).toBe(false);
    expect(proof.thresholds.find((t: any) => t.name === "changed_payment_details")).toBeTruthy();
    const ai = (await stranger.get("/api/public/ai")).json;
    expect(Array.isArray(ai.showcase)).toBe(true);
    expect(ai.yours).toBeNull();
    const pp = (await stranger.get("/api/public/paypal")).json;
    expect(pp.apis.length).toBe(8);
    expect(pp.apis.filter((a: any) => a.error)).toEqual([]); // every query ran (a failed read would say so, not "none yet")
    expect(pp.mcp_tools.every((t: string) => /^(get|list|show)_/.test(t))).toBe(true);
    const f = (await stranger.get("/api/public/facts")).json;
    expect(f.limits.auto_charge_max_cents).toBe(30000);
    expect(f.roles.length).toBeGreaterThanOrEqual(7);
  });

  it("every non-foundation route was walked and nothing returned 5xx", () => {
    expect(srv.failures).toEqual([]);
    // Private-workspace routes run with workspaces on and are walked by workspaces.test.ts.
    const missed = srv.missed((r) => isFoundationRoute(r) || /\/static|\/healthz|ALL |\/demo\/start|\/demo\/join|\/wallet\//.test(r));
    expect(missed).toEqual([]);
  });
});
