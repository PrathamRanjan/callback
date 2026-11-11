import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { decide, decisionsBody, thresholds, verdict } from "../src/ai/decisions.js";
import { setProviderFetch } from "../src/ai/provider.js";
import { scanText } from "../src/safety/rules.js";
import { clearScanMemo, extractDestinations, PAY_SOMEWHERE, SCAM_QUESTIONS, scanMessage } from "../src/safety/readers.js";
import { freshWorld } from "./setup.js";

// Spec A5.2 (Decisions client) and A6.1-A6.3 (three readers, never a false all-clear, the widened rule).
const SET: { id: string; group: string; text: string; yes: string[] }[] = JSON.parse(readFileSync("eval/decisions/scam-set.json", "utf8"));
const NOV10 = SET.filter((r) => r.group === "nov10");
const saved = { provider: config.ai.provider, key: config.ai.openaiKey };
afterEach(() => {
  setProviderFetch(null);
  Object.assign(config.ai, saved);
  clearScanMemo();
});
const useModel = () => Object.assign(config.ai, { provider: "openai", openaiKey: "test-key" });
/** A fake Decisions API answering every question with the probability `p(name)`, or an HTTP status. */
function fakeDecisions(p: ((name: string) => number | "refuse") | number) {
  const bodies: any[] = [];
  setProviderFetch((async (u: any, init: any) => {
    bodies.push({ url: String(u), body: JSON.parse(init.body) });
    if (typeof p === "number") return new Response("down", { status: p });
    const b = bodies.at(-1).body;
    return new Response(JSON.stringify({ model: "gpt-6-luna", answers: b.questions.map((q: any) => { const v = p(q.name); return v === "refuse" ? { type: "refusal", name: q.name, refusal: "no" } : { type: "predicate", name: q.name, probability: v }; }), usage: { input_tokens: 700 } }), { status: 200 });
  }) as typeof fetch);
  return bodies;
}

describe("A6.3 the widened changed-details rule", () => {
  it("fires on the 10 Nov message and all 30 paraphrases", () => {
    expect(NOV10.length).toBe(31);
    for (const r of NOV10) expect(scanText(r.text).tactics.changed_details, r.text).toBe(true);
  });
  it("covers the spec's phrasings in either order", () => {
    for (const t of ["Our old one is being closed next week.", "Please use this account instead.", "The beneficiary has been updated.", "We switched our remittance details.", "IBAN changed as of today", "moved banks"]) expect(scanText(t).tactics.changed_details, t).toBe(true);
  });
  it("does not fire on ordinary customer and studio messages", () => {
    for (const r of SET.filter((x) => x.group.startsWith("g_"))) expect(scanText(r.text).tactics.changed_details, r.text).toBe(false);
  });
});

describe("A6.1 the code reader", () => {
  const onFile = { hosts: ["pph-callback.onrender.com"], emails: ["accounts@brightside-physio.example"], ownDomain: "brightside-physio.example" };
  it("pulls out places to pay and checks them against the record", () => {
    const d = extractDestinations(NOV10[0].text, onFile);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: "email", value: "accounts.brightside@outlook.com", on_file: false });
    expect(d[0].why).toMatch(/free-mail/);
    expect(extractDestinations("Please pay to accounts@brightside-physio.example as usual.", onFile)[0].on_file).toBe(true);
    expect(extractDestinations("Send the fees to paypal.me/brightsidenew", onFile)[0].kind).toBe("paypal");
    expect(extractDestinations("Pay to account 0099 1234 5678 please", onFile)[0].kind).toBe("account");
    expect(extractDestinations("Your balance is on https://pph-callback.onrender.com/c/abc, pay there.", onFile)[0].on_file).toBe(true);
  });
  it("an address with no payment around it is a contact, not a destination", () => {
    expect(extractDestinations("Could you email me the receipt? My email is lena.ortiz@gmail.com", onFile)).toEqual([]);
  });
});

describe("A5.2 the Decisions client", () => {
  it("one request carries every question, on gpt-6-luna", async () => {
    await freshWorld();
    useModel();
    const bodies = fakeDecisions(() => 0.9);
    const r = await decide("hello", SCAM_QUESTIONS, { purpose: "scam_check" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].url).toMatch(/\/v1\/decisions$/);
    expect(bodies[0].body.model).toBe("gpt-6-luna");
    expect(bodies[0].body.questions).toHaveLength(SCAM_QUESTIONS.length);
    expect(r.answers.impersonation.probability).toBe(0.9);
  });
  it("a refusal is not decided, and an unanswered question is not decided", async () => {
    await freshWorld();
    useModel();
    fakeDecisions((n) => (n === "impersonation" ? "refuse" : 0.1));
    const r = await decide("hello", SCAM_QUESTIONS, { purpose: "scam_check" });
    expect(r.answers.impersonation.refused).toBe(true);
    expect(verdict(r.answers.impersonation, "impersonation")).toBe("not_decided");
    expect(verdict(undefined, "impersonation")).toBe("not_decided");
  });
  it("thresholds come from the calibrated file, never the model", () => {
    const t = thresholds();
    for (const q of SCAM_QUESTIONS) expect(t[q.name], q.name).toBeTruthy();
    expect(t.names_a_payment_destination.calibrated_on).toMatch(/scam-set/);
    expect(decisionsBody("x", SCAM_QUESTIONS).questions.every((q: any) => !("threshold" in q))).toBe(true);
  });
  it("every call is logged to ai_calls with questions and answers", async () => {
    const { db } = await freshWorld();
    useModel();
    fakeDecisions(() => 0.3);
    await decide("hello", SCAM_QUESTIONS, { purpose: "scam_check" });
    const row = (await db.query<any>("SELECT * FROM ai_calls WHERE via = 'decisions' ORDER BY id DESC LIMIT 1")).rows[0];
    expect(row.ok).toBe(true);
    expect(row.model).toBe("gpt-6-luna");
    expect(row.tokens_in).toBe(700);
    const out = typeof row.output === "string" ? JSON.parse(row.output) : row.output;
    expect(out.questions).toContain("names_a_payment_destination");
    expect(out.answers.asks_for_payment.probability).toBe(0.3);
  });
});

describe("A6.1 and A6.2 strictest wins, never a false all-clear", () => {
  it("the 10 Nov message is held by every reader", async () => {
    const { db, seeded } = await freshWorld();
    useModel();
    fakeDecisions((n) => (["changed_payment_details", "asks_for_payment", "names_a_payment_destination", "pay_outside_paypal"].includes(n) ? 1 : 0.02));
    const s = await scanMessage(NOV10[0].text, { businessId: seeded.business.id, q: db });
    expect(s.level).toBe("hold");
    expect(s.readers.rules.level).toBe("hold");
    expect(s.readers.decisions.level).toBe("hold");
    expect(s.readers.code.level).toBe("hold");
    expect(s.all_clear_allowed).toBe(false);
  });
  it("a genuine message is clear only when every reader ran and is clear", async () => {
    const { db, seeded } = await freshWorld();
    useModel();
    fakeDecisions(() => 0.01);
    const s = await scanMessage("Can I move my Thursday class to Saturday morning?", { businessId: seeded.business.id, q: db });
    expect(s.level).toBe("clear");
    expect(s.all_clear_allowed).toBe(true);
  });
  it("with the AI reader down nothing is green, even for a harmless message", async () => {
    const { db, seeded } = await freshWorld();
    useModel();
    fakeDecisions(503);
    const s = await scanMessage("Can I move my Thursday class to Saturday morning?", { businessId: seeded.business.id, q: db });
    expect(s.readers.decisions.level).toBe("not_run");
    expect(s.all_clear_allowed).toBe(false);
    expect(s.summary).toMatch(/not fully checked/);
  });
  it("with no model configured the AI reader never runs and nothing is green", async () => {
    const { db, seeded } = await freshWorld();
    Object.assign(config.ai, { provider: "rules" });
    const s = await scanMessage("Thanks, see you Tuesday!", { businessId: seeded.business.id, q: db });
    expect(s.readers.decisions.why_not_run).toMatch(/no AI model/);
    expect(s.all_clear_allowed).toBe(false);
  });
  it("a message that names a place to pay is never green, even when nothing else fires", async () => {
    const { db, seeded } = await freshWorld();
    useModel();
    fakeDecisions((n) => (n === "names_a_payment_destination" || n === "asks_for_payment" ? 0.99 : 0.01));
    const s = await scanMessage("Hi, please pay the deposit to accounts@brightside-physio.example as usual.", { businessId: seeded.business.id, q: db });
    expect(s.level).toBe("caution");
    expect(s.reasons[0]).toBe(PAY_SOMEWHERE);
    expect(s.all_clear_allowed).toBe(false);
  });
  it("a refusal routes the message to a person (amber, not green)", async () => {
    const { db, seeded } = await freshWorld();
    useModel();
    fakeDecisions((n) => (n === "impersonation" ? "refuse" : 0.01));
    const s = await scanMessage("Hello from the studio", { businessId: seeded.business.id, q: db });
    expect(s.level).toBe("caution");
    expect(s.all_clear_allowed).toBe(false);
  });
});
