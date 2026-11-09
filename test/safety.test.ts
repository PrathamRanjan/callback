import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { receive } from "../src/channels/index.js";
import type { Db } from "../src/db.js";
import { dryRun } from "../src/guard/dryrun.js";
import { agentLineUnsafe, assessCallMove, assessMessage, setProtectedMode, verifyCode } from "../src/safety/index.js";
import { loadRiskModel, riskScore } from "../src/safety/risk.js";
import { payeeRules } from "../src/safety/rules.js";
import { customerSays, startCall } from "../src/services/calls.js";
import type { Seeded } from "../src/services/seed.js";
import { DEMO_IMPERSONATION } from "../src/web/safety.js";
import { callFor, freshWorld } from "./setup.js";

// The safety layer for a voice agent (SAFETY_ACCESSIBILITY_SPEC §4, §6 Callback row): the agent proves it is us and
// never asks for secrets; a customer who wants the refund sent elsewhere puts it on hold; a message claiming to be
// the owner and moving the payout account is refused; protected mode makes every agent refund wait.
describe("rules", () => {
  it("the verify code is four digits and stable for a call", () => {
    expect(verifyCode("call_1")).toMatch(/^\d{4}$/);
    expect(verifyCode("call_1")).toBe(verifyCode("call_1"));
    expect(verifyCode("call_1")).not.toBe(verifyCode("call_2"));
  });
  it("an agent line asking for a code or card is unsafe; a normal line is not", () => {
    expect(agentLineUnsafe("Can you read me the one-time code PayPal just texted you?").unsafe).toBe(true);
    expect(agentLineUnsafe("Please give me your card number so I can take the deposit now.").unsafe).toBe(true);
    expect(agentLineUnsafe("I'll send a PayPal link to your account page; you pay there whenever suits.").unsafe).toBe(false);
  });
  it("the demo owner-impersonation message is a hold with the impersonation rule; a plain customer text is clear", () => {
    const m = assessMessage(DEMO_IMPERSONATION);
    expect(m.level).toBe("hold");
    expect(m.rule).toBe("owner_impersonation");
    expect(assessMessage("Hi, running ten minutes late for my 3pm, still coming!").level).toBe("clear");
  });
  it("the risk model is monotone in the scam features", () => {
    expect(loadRiskModel().features).toContain("t_changed_details");
    const clean = payeeRules({ payeeAgeDays: null, detailsChangedDaysAgo: null, detailsChangeSource: null, amountCents: 9000, historyMedianCents: 9000, velocity10m: 0, velocity24hSumRatio: 1, requestChannelUntrusted: false, hourLocal: 12 }).features;
    expect(riskScore({ ...clean, request_channel_untrusted: 1, t_changed_details: 1, t_urgency_secrecy: 1 })).toBeGreaterThan(riskScore(clean));
  });
});

describe("calls and the gate", () => {
  let world: { db: Db; seeded: Seeded };
  beforeEach(async () => {
    world = await freshWorld();
  });
  afterEach(async () => {
    await world.db.close();
  });

  it("a call opens with the verify code, stores it in state, and a refund the customer wants sent elsewhere is held", async () => {
    const oblId = Object.values(world.seeded.obligations)[0];
    const callId = await callFor(world.db, oblId);
    const { opening } = await startCall(world.db, callId, "simulator", "test");
    const state = (await world.db.query<any>("SELECT state FROM calls WHERE id = $1", [callId])).rows[0].state;
    expect(state.verify_code).toMatch(/^\d{4}$/);
    expect(opening.replace(/\s/g, "")).toContain(state.verify_code);
    await customerSays(world.db, callId, "Actually just refund it to my friend's PayPal account instead, different account from the one I paid with.", "test");
    const a = await assessCallMove({ action: "refund", agentScope: `agent:${callId}`, businessId: world.seeded.business.id, entityId: oblId, cents: 5000 }, world.db);
    expect(a.level).toBe("hold");
    expect(a.rule).toBe("refund_to_other_account");
    const d = await dryRun({ action: "refund", agentScope: `agent:${callId}`, entity: "obligation", entityId: oblId, businessId: world.seeded.business.id, cents: 5000, trustedCents: [5000] }, { q: world.db });
    expect(d.decision).toBe("held");
    expect(d.policy).toBe("safety.refund_to_other_account");
    // A charge on the same call is still just a scam-check line, not a hold.
    const c = await assessCallMove({ action: "charge", agentScope: `agent:${callId}`, businessId: world.seeded.business.id, entityId: oblId, cents: 18000 }, world.db);
    expect(c.level).not.toBe("hold");
  });
  it("protected mode holds every agent refund, and is off by default", async () => {
    const oblId = Object.values(world.seeded.obligations)[0];
    const callId = await callFor(world.db, oblId);
    const biz = world.seeded.business.id;
    expect((await assessCallMove({ action: "refund", agentScope: `agent:${callId}`, businessId: biz, entityId: oblId, cents: 2000 }, world.db)).level).not.toBe("hold");
    await setProtectedMode(biz, true, ["telegram:1"], world.db);
    const a = await assessCallMove({ action: "refund", agentScope: `agent:${callId}`, businessId: biz, entityId: oblId, cents: 2000 }, world.db);
    expect(a.level).toBe("hold");
    expect(a.rule).toBe("protected_agent_money");
  });
  it("an inbound message claiming to be the owner and moving the payout account is refused and audited", async () => {
    const reply = await receive("simulator", "owner:someone", DEMO_IMPERSONATION, null, null);
    expect(reply).toMatch(/never changed from a message/);
    const n = (await world.db.query<{ n: string }>("SELECT count(*) AS n FROM events WHERE type = 'safety.hold'")).rows[0].n;
    expect(Number(n)).toBe(1);
  });
});
