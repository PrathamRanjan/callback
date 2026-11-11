/**
 * The audit fixes: records the owner creates (not the seed) flow through planner, call, gate and PayPal with their own
 * values; a paid booking cancelled by the owner is refunded to its real capture; an approval given after the call
 * ended is carried out; the model cannot say an amount the records did not give it; demo mode never texts or dials
 * a number nobody listed; and the web app gets JSON back from the form routes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { inventedAmounts, rulesBrain, type BrainContext } from "../src/ai/agent.js";
import { deliver, send } from "../src/channels/index.js";
import { config, mayContactForReal } from "../src/config.js";
import { decideApproval, pendingApprovals } from "../src/guard/dryrun.js";
import { setPayPal } from "../src/paypal/index.js";
import { customerSays, endCall, startCall } from "../src/services/calls.js";
import { readBack } from "../src/services/money.js";
import { planCalls } from "../src/services/planner.js";
import { cancelBooking, centsFromDollars, createCharge, createCustomer, normalisePhone } from "../src/services/records.js";
import { callById, obligationById } from "../src/store.js";
import { createApp } from "../src/app.js";
import { Client } from "./client.js";
import { serveTracked } from "./journey-coverage.js";
import { callFor, freshWorld, NOW } from "./setup.js";

afterEach(() => setPayPal(null));

const DAY = 86400_000;

describe("owner's own records", () => {
  it("validates input in plain words", () => {
    expect(centsFromDollars("1,250.5")).toBe(125050);
    expect(centsFromDollars("$60")).toBe(6000);
    expect(() => centsFromDollars("-5")).toThrow(/amount/);
    expect(() => centsFromDollars("12.345")).toThrow(/amount/);
    expect(() => centsFromDollars("0")).toThrow(/between/);
    expect(normalisePhone("+61 491 570 313")).toBe("+61 491 570 313");
    expect(() => normalisePhone("0491 570 313")).toThrow(/international/);
  });

  it("a brand-new customer and invoice flow through planner, call, gate and PayPal with their own values", async () => {
    const { db, fake, seeded } = await freshWorld();
    const biz = seeded.business.id;
    const c = await createCustomer(db, biz, { name: "Ines Albarrán", phone: "+61 491 570 313", email: "ines@example.com", tz: "Australia/Perth", consent: { text: "Call me about my account", source: "intake form 2 Feb" } }, "Maya Chen");
    await expect(createCustomer(db, biz, { name: "Dup", phone: "+61 491 570 313", tz: "Australia/Perth" }, "x")).rejects.toThrow(/already exists/);
    const o = await createCharge(db, biz, { customerId: c.id, kind: "invoice", title: "Invoice #2001: hydrotherapy x2", amount: "137.40", dueAt: new Date(NOW.getTime() - 12 * DAY).toISOString() }, "Maya Chen");
    expect(o.amount_cents).toBe(13740);
    await planCalls(db, biz, "test", NOW);
    const id = await callFor(db, o.id);
    const call = await callById(db, id);
    // Perth is three hours behind Sydney in March: 10:00 there, inside the 9–6 window.
    expect(call.status).toBe("planned");
    expect(call.reason).toMatch(/\$137\.40 overdue by 12 days/);
    const start = await startCall(db, id, "simulator", "test");
    expect(start.opening).toMatch(/Ines/);
    const r = await customerSays(db, id, "Okay, text me the link please.");
    expect(r.tool).toBe("send_pay_link");
    expect(r.gate).toBe("allowed");
    const body = fake.bodies.find((b) => b.method === "createOrder")!.body as any;
    expect(body.amountCents).toBe(13740);
    expect(body.customId).toBe(o.id);
    const after = await obligationById(db, o.id);
    expect(after.status).toBe("link_sent");
    fake.approveOrder(after.paypal_order_id!);
    expect(await readBack(db, biz)).toBe(1);
    const paid = await obligationById(db, o.id);
    expect(paid.status).toBe("paid");
    expect(paid.settled_cents).toBe(13740);
    await db.close();
  });

  it("a deposit needs its appointment after the due time", async () => {
    const { db, seeded } = await freshWorld();
    const c = Object.values(seeded.customers)[0];
    await expect(createCharge(db, seeded.business.id, { customerId: c.id, kind: "deposit", title: "Deposit for review", amount: "40", dueAt: NOW.toISOString(), appointmentAt: new Date(NOW.getTime() - 3600_000).toISOString() }, "x")).rejects.toThrow(/before the appointment/);
    await db.close();
  });

  it("cancelling a paid booking: the agent gives the owner's reason and refunds the real capture", async () => {
    const { db, fake, seeded } = await freshWorld();
    const biz = seeded.business.id;
    const priya = seeded.obligations.priya_deposit;
    const id = await callFor(db, priya);
    await startCall(db, id, "simulator", "test");
    await customerSays(db, id, "Yes, send me the link");
    const o = await obligationById(db, priya);
    fake.approveOrder(o.paypal_order_id!);
    await readBack(db, biz);
    const paid = await obligationById(db, priya);
    expect(paid.status).toBe("paid");
    expect(paid.capture_id).toBeTruthy();
    await expect(cancelBooking(db, biz, seeded.obligations.marcus_deposit, "room flooded", "Maya")).rejects.toThrow(/not paid/);
    const cancel = await cancelBooking(db, biz, priya, "the clinic lost power", "Maya");
    expect(cancel.kind).toBe("class_cancel");
    expect(cancel.capture_id).toBe(paid.capture_id);
    expect(cancel.settled_cents).toBe(6000);
    await expect(cancelBooking(db, biz, priya, "again", "Maya")).rejects.toThrow(/already cancelled/);
    await db.query("DELETE FROM calls WHERE customer_id = $1", [paid.customer_id]); // one attempt a day: let the planner ring again
    await planCalls(db, biz, "test", NOW);
    const cid = await callFor(db, cancel.id);
    await startCall(db, cid, "simulator", "test");
    const ask = await customerSays(db, cid, "Hello? What's this about?");
    expect(ask.say).toMatch(/the clinic lost power/);
    expect(ask.say).not.toMatch(/instructor/);
    const r = await customerSays(db, cid, "A refund please.");
    expect(r.tool).toBe("settle_refund");
    expect(r.gate).toBe("allowed");
    const refund = fake.bodies.find((b) => b.method === "refundCapture")!.body as any;
    expect(refund.captureId).toBe(paid.capture_id);
    expect(refund.amountCents).toBe(6000);
    expect((await obligationById(db, cancel.id)).status).toBe("refunded");
    await db.close();
  });
});

describe("approvals are carried out", () => {
  it("an approval given after the call ended sends the exact approved link", async () => {
    const { db, fake, seeded } = await freshWorld();
    const id = await callFor(db, seeded.obligations.harbour_invoice);
    await startCall(db, id, "simulator", "test");
    const r = await customerSays(db, id, "Sure, send the link.");
    expect(r.gate).toBe("held");
    await endCall(db, id, null, "test");
    const pend = (await pendingApprovals(seeded.business.id)).filter((a) => a.status === "pending");
    const d = await decideApproval(pend[0].id, true, "click", "Maya", seeded.business.id);
    expect(d.followUp?.done).toBe(true);
    expect(d.followUp?.message).toMatch(/\$420\.00/);
    expect(fake.calls).toContain("createOrder");
    expect((await obligationById(db, seeded.obligations.harbour_invoice)).status).toBe("link_sent");
    await db.close();
  });
  it("while the call is still on the line, the agent does it", async () => {
    const { db, fake, seeded } = await freshWorld();
    const id = await callFor(db, seeded.obligations.harbour_invoice);
    await startCall(db, id, "simulator", "test");
    await customerSays(db, id, "Sure, send the link.");
    const pend = (await pendingApprovals(seeded.business.id)).filter((a) => a.status === "pending");
    const d = await decideApproval(pend[0].id, true, "click", "Maya", seeded.business.id);
    expect(d.followUp?.done).toBe(false);
    expect(fake.calls).not.toContain("createOrder");
    await db.close();
  });
});

describe("the model cannot say money the records did not give it", () => {
  const ctx: BrainContext = { business: "B", customer_first_name: "Tom", purpose: "chase_invoice", item: "Invoice #1", note: "", balance_text: "$220.00", due_text: "", tone: "warm", turn: 2, done: { link_sent: false, hold_sent: false, invoice_sent: false, discount_applied: false, plan_sent: false, callback_set: false, settled: false }, options: { discounts: [{ id: "d5", label: "5% off, so $209.00 today" }], plans: [{ id: "plan2", label: "2 fortnightly payments of $110.00" }], slots: [] }, transcript: [], last_customer_line: "can you do better" };
  it("flags amounts and percentages that are not in the balance or the options", () => {
    expect(inventedAmounts("It's $220.00, or 5% off makes it $209.00, or two of $110.00.", ctx)).toEqual([]);
    expect(inventedAmounts("I can do $150 today, that's 30% off.", ctx)).toEqual(["$150", "30%"]);
  });
  it("a cancelled class without a note gives no invented reason", () => {
    const d = rulesBrain({ ...ctx, purpose: "cancel_class", item: "Friday 3pm reformer class", last_customer_line: "what's this about?" });
    expect(d.say).toMatch(/cancel Friday 3pm reformer class\./);
    expect(d.say).not.toMatch(/instructor|unwell|ill/);
  });
});

describe("demo mode never contacts a number nobody listed", () => {
  it("seeded numbers are simulated; listed ones may be real", async () => {
    const { db } = await freshWorld();
    const prev = config.liveContactAllowlist;
    expect(config.demoMode).toBe(true);
    (config as any).liveContactAllowlist = ["+61491570999"];
    expect(mayContactForReal("+61 491 570 006")).toBe(false);
    expect(mayContactForReal("+61 491 570 999")).toBe(true);
    const sid = (config.voice as any).twilioSid;
    Object.assign(config.voice, { twilioSid: "AC_test", twilioToken: "t", twilioFrom: "+15550100" });
    const id = await send({ channel: "sms", address: "+61 491 570 006", body: "hi" }, db);
    await deliver(id);
    expect((await db.query<any>("SELECT status FROM channel_messages WHERE id = $1", [id])).rows[0].status).toBe("simulated");
    Object.assign(config.voice, { twilioSid: sid, twilioToken: "", twilioFrom: "" });
    (config as any).liveContactAllowlist = prev;
    await db.close();
  });
});

describe("web app actions get JSON from the form routes", () => {
  let world: Awaited<ReturnType<typeof freshWorld>>;
  let srv: Awaited<ReturnType<typeof serveTracked>>;
  beforeAll(async () => {
    world = await freshWorld();
    srv = await serveTracked(createApp());
  });
  afterAll(async () => {
    await srv.close();
    await world.db.close();
  });
  it("sign in, create a customer and a charge, read them back", async () => {
    const app = new Client(srv.base);
    const H = { "x-callback-app": "1" };
    const login = await app.req("POST", "/login", { form: { key: world.seeded.ownerKey, next: "/today" }, headers: H });
    expect(login.json).toMatchObject({ ok: true, to: "/today" });
    const bad = await app.req("POST", "/customers", { form: { name: "X", phone: "123", tz: "Australia/Sydney" }, headers: H });
    expect(bad.status).toBe(422);
    expect(bad.json.message).toMatch(/name|international/);
    const ok = await app.req("POST", "/customers", { form: { name: "Wen Li", phone: "+61 491 570 737", tz: "Australia/Sydney", consent_text: "Yes you may call", consent_source: "front desk" }, headers: H });
    expect(ok.json.ok).toBe(true);
    const cid = ok.json.to.split("/").pop();
    const ch = await app.req("POST", `/customers/${cid}/charges`, { form: { kind: "deposit", title: "Deposit for clinical Pilates intro", amount: "45", due_at: new Date(NOW.getTime() + 20 * 3600_000).toISOString(), appointment_at: new Date(NOW.getTime() + 26 * 3600_000).toISOString() }, headers: H });
    expect(ch.json.message).toMatch(/\$45\.00/);
    const detail = (await app.get(`/api/app/customers/${cid}`)).json;
    expect(detail.items[0]).toMatchObject({ title: "Deposit for clinical Pilates intro", balance_cents: 4500, kind: "deposit" });
    const today = (await app.get("/api/app/today")).json;
    expect(today.ready.some((c: any) => c.item?.title === "Deposit for clinical Pilates intro" && c.item.balance_cents === 4500)).toBe(true);
    expect((await new Client(srv.base).get("/api/app/today")).status).toBe(401);
    const sess = (await app.get("/api/app/session")).json;
    expect(sess.me.role).toBe("owner");
  });
});
