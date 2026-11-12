import { describe, expect, it } from "vitest";
import { amountsSpoken, customerText, detectLang, line, normLang, paypalLocale } from "../src/lib/lang.js";
import { inventedAmounts, type BrainContext } from "../src/ai/agent.js";
import { liveInstructions } from "../src/voice/live.js";

describe("languages on the server (spec B, item 5)", () => {
  it("normalises the codes people and browsers send", () => {
    expect(normLang("hi")).toBe("hi-IN");
    expect(normLang("pt")).toBe("pt-BR");
    expect(normLang("in")).toBe("id-ID");
    expect(normLang("en-GB")).toBe("en");
    expect(normLang("fr")).toBeNull();
    expect(normLang("")).toBeNull();
  });

  it("tells the caller's language from the first words, and waits when it can't tell", () => {
    expect(detectLang("हाँ, मैं अभी पेमेंट कर सकता हूँ")).toBe("hi-IN");
    expect(detectLang("haan ji, abhi theek hai")).toBe("hi-IN");
    expect(detectLang("Ya, saya bisa bayar sekarang, terima kasih")).toBe("id-ID");
    expect(detectLang("Sim, posso pagar agora, obrigado")).toBe("pt-BR");
    expect(detectLang("Yes, I can pay that now, thank you")).toBe("en");
    expect(detectLang("Priya")).toBeNull();
    expect(detectLang("")).toBeNull();
  });

  it("reads amounts said in any of the four languages, so the money guard doesn't depend on English", () => {
    expect(amountsSpoken("That's $420.00 today")).toEqual(["420.00"]);
    expect(amountsSpoken("420 dollars")).toEqual(["420.00"]);
    expect(amountsSpoken("आपको 420 डॉलर देने हैं")).toEqual(["420.00"]);
    expect(amountsSpoken("São US$ 420,00 hoje")).toEqual(["420.00"]);
    expect(amountsSpoken("são 999 dólares")).toEqual(["999.00"]);
    expect(amountsSpoken("totalnya 1.234 dolar")).toEqual(["1234.00"]);
    expect(amountsSpoken("$1,234.50")).toEqual(["1234.50"]);
  });

  it("the call brain's invented-amount check catches amounts in words in another language", () => {
    const ctx = { balance_text: "$420.00", options: { discounts: [{ id: "d1", label: "10% off: $378.00" }], plans: [], slots: [] } } as unknown as BrainContext;
    expect(inventedAmounts("Você deve $420.00.", ctx)).toEqual([]);
    expect(inventedAmounts("Você deve 999 dólares.", ctx)).toEqual(["999.00"]);
    expect(inventedAmounts("आपको 300 डॉलर देने हैं।", ctx)).toEqual(["300.00"]);
    expect(inventedAmounts("Saya bisa memberi potongan 50 persen.", ctx)).toEqual(["50 persen"]);
    expect(inventedAmounts("Posso dar 10 por cento.", ctx)).toEqual([]);
  });

  it("set lines and texts come in the customer's language, with the amount from the record", () => {
    expect(line("hold_sent", "pt-BR", { amount: "$40.00", item: "Pilates" })).toContain("$40.00");
    expect(line("hold_sent", "pt-BR", { amount: "$40.00", item: "Pilates" })).toMatch(/pré-autorizar/);
    expect(line("stop", "hi-IN")).toMatch(/कॉल नहीं करेंगे/);
    expect(line("stop", null)).toBe("Understood. We won't call you again. Goodbye.");
    expect(customerText("pay_link", "id-ID", { business: "Studio", amount: "US$40.00", item: "Kelas", url: "https://x" })).toBe("Studio: ini tautan PayPal Anda untuk US$40.00 (Kelas): https://x");
  });

  it("every line code says on a call exists in all four languages, with the same placeholders", () => {
    const keys = ["next_cancel", "next_pay", "held_wait", "held_later", "held_discount_tail", "denied_discount", "denied", "failed", "paypal_failed", "what_link", "what_invoice", "what_plan", "what_refund", "dispute", "correction"] as const;
    for (const k of keys) {
      const en = line(k, "en", {});
      for (const l of ["hi-IN", "id-ID", "pt-BR"] as const) {
        const s = line(k, l, {});
        expect(s, `${k} ${l}`).not.toBe(en);
        expect([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(), `${k} ${l}`).toEqual([...en.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort());
      }
    }
    expect(line("paypal_failed", "pt-BR", { what: line("what_link", "pt-BR") })).toBe("Não consegui preparar o link de pagamento no PayPal agora, e nada foi cobrado. O escritório vai falar com você hoje.");
    expect(line("failed", "en")).toBe("I couldn't do that just now.");
  });

  it("PayPal gets a checkout locale only for non-English customers (English orders are unchanged)", () => {
    expect(paypalLocale("en")).toBeUndefined();
    expect(paypalLocale(undefined)).toBeUndefined();
    expect(paypalLocale("pt-BR")).toBe("pt-BR");
    expect(paypalLocale("hi-IN")).toBe("en-IN"); // PayPal has no Hindi checkout
  });

  it("the voice model is told to greet in the customer's language and follow theirs", () => {
    const s = liveInstructions({ business: "Studio", firstName: "Ana", purpose: "chase_invoice", item: "Invoice 12", lang: "pt-BR" });
    expect(s).toMatch(/Greet in Brazilian Portuguese/);
    expect(s).toMatch(/continue the rest of the call in that language/);
    expect(s).not.toMatch(/\$\d/); // still no amounts in the instructions
  });
});
