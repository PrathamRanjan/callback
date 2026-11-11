import { afterEach, describe, expect, it } from "vitest";
import { clientIp } from "../src/web/common.js";

// On Render every request arrives from Render's own proxy (10.x); the visitor is in Cloudflare's headers.
const req = (ip: string, headers: Record<string, string> = {}) => ({ ip, headers }) as any;
const was = process.env.RENDER;
afterEach(() => {
  if (was === undefined) delete process.env.RENDER;
  else process.env.RENDER = was;
});

describe("the address the per-address limits count", () => {
  it("on Render: the visitor from Cloudflare's header, not Render's shared proxy", () => {
    process.env.RENDER = "true";
    expect(clientIp(req("10.28.1.2", { "cf-connecting-ip": "58.96.1.2", "true-client-ip": "58.96.1.2", "x-forwarded-for": "58.96.1.2, 162.158.1.1, 10.28.1.2" }))).toBe("58.96.1.2");
    expect(clientIp(req("10.28.1.2", { "true-client-ip": "58.96.1.3" }))).toBe("58.96.1.3");
    // Two visitors behind the same Render proxy are two addresses.
    expect(clientIp(req("10.28.1.2", { "cf-connecting-ip": "1.1.1.1" }))).not.toBe(clientIp(req("10.28.1.2", { "cf-connecting-ip": "2.2.2.2" })));
  });
  it("a made-up X-Forwarded-For changes nothing", () => {
    process.env.RENDER = "true";
    expect(clientIp(req("10.28.1.2", { "cf-connecting-ip": "58.96.1.2", "x-forwarded-for": "203.0.113.77, 58.96.1.2, 162.158.1.1, 10.28.1.2" }))).toBe("58.96.1.2");
  });
  it("off Render the headers are not trusted: req.ip", () => {
    delete process.env.RENDER;
    expect(clientIp(req("127.0.0.1", { "cf-connecting-ip": "9.9.9.9" }))).toBe("127.0.0.1");
  });
});
