import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

export function sign(value: string): string {
  const mac = createHmac("sha256", config.sessionSecret).update(value).digest("base64url");
  return `${value}.${mac}`;
}

export function unsign(signed: string | undefined): string | null {
  if (!signed) return null;
  const i = signed.lastIndexOf(".");
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const a = Buffer.from(sign(value));
  const b = Buffer.from(signed);
  return a.length === b.length && timingSafeEqual(a, b) ? value : null;
}
