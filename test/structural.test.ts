import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafeSchema, requestBody } from "../src/ai/provider.js";
import { PAYPAL_WRITES } from "../src/paypal/index.js";

// Structural guarantees (roadmap B.1, B.6): the model layer never imports PayPal, the services or the guard; no model
// schema asks for money, a percentage, a phone or an id; the API key never appears in a request body; every PayPal
// write in the services sits behind the gate; the adversarial harness never names a PayPal write.
const root = join(import.meta.dirname, "..", "src");
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));

describe("structural guarantees", () => {
  it("the ai layer never imports the PayPal client, the services or the guard", () => {
    for (const f of files(join(root, "ai"))) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/from "\.\.\/paypal|from "\.\.\/services|from "\.\.\/guard|from "\.\.\/voice/);
    }
  });
  it("no model schema carries a money, percentage, phone or PayPal id field", () => {
    for (const name of ["agent.ts"]) {
      const src = readFileSync(join(root, "ai", name), "utf8");
      expect(src, name).not.toMatch(/\b(amount|amount_cents|cents|price|discount_pct|percent|phone|order_id|capture_id|invoice_id|subscription_id|plan_id)\b\s*:\s*\{\s*type/);
    }
    const realtime = readFileSync(join(root, "voice", "realtime.ts"), "utf8");
    expect(realtime).not.toMatch(/\b(amount|cents|discount_pct|percent|phone|order_id|capture_id)\b\s*:\s*\{\s*type/);
    expect(() => assertSafeSchema({ type: "object", properties: { amount_cents: { type: "number" } } })).toThrow();
    expect(() => assertSafeSchema({ type: "object", properties: { discount_pct: { type: "number" } } })).toThrow();
    expect(() => assertSafeSchema({ type: "object", properties: { phone: { type: "string" } } })).toThrow();
    expect(() => assertSafeSchema({ type: "object", properties: { subscription_id: { type: "string" } } })).toThrow();
    expect(() => assertSafeSchema({ type: "object", properties: { say: { type: "string" }, option_id: { type: ["string", "null"] }, discount_quote: { type: ["string", "null"] } } })).not.toThrow();
  });
  it("the API key never leaks into a request body", () => {
    const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };
    const body = JSON.stringify(requestBody("gpt-x", { purpose: "turn", tier: "read", system: "s", parts: [{ type: "text", text: "sk-SENTINEL-KEY" }], schemaName: "x", schema }, schema));
    expect(body).toContain("sk-SENTINEL-KEY");
    expect(body).not.toMatch(/authorization|bearer/i);
  });
  it("every PayPal write in the services is preceded by a gate call in the same function", () => {
    const writes = new RegExp(`\\b(pp|paypal\\(\\))\\.(${PAYPAL_WRITES.join("|")})\\(`, "g");
    let seen = 0;
    for (const f of files(join(root, "services"))) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(writes)) {
        seen++;
        const before = src.slice(0, m.index);
        const fnStart = Math.max(before.lastIndexOf("\nexport async function"), before.lastIndexOf("\nasync function"));
        const body = src.slice(fnStart, m.index);
        expect(body, `${f}: ${m[0]} at ${m.index}`).toMatch(/\bgate\(/);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(8);
  });
  it("the adversarial harness never reaches a PayPal write", () => {
    const src = readFileSync(join(root, "eval", "adversarial.ts"), "utf8");
    for (const w of PAYPAL_WRITES) expect(src).not.toMatch(new RegExp(`\\.${w}\\(`));
  });
  it("consent is enforced in code: the planner and startCall both call mayCall", () => {
    expect(readFileSync(join(root, "services", "planner.ts"), "utf8")).toMatch(/mayCall\(/);
    expect(readFileSync(join(root, "services", "calls.ts"), "utf8")).toMatch(/mayCall\(/);
  });
});
