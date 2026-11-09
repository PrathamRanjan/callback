import { createHash, randomBytes } from "node:crypto";

export class GtError extends Error {
  constructor(message: string, readonly code: string, readonly status = 400, readonly data?: unknown) {
    super(message);
  }
}

export const dollars = (cents: number) => (cents / 100).toFixed(2);
export const fmt = (cents: number | null | undefined) => (cents === null || cents === undefined ? "—" : `$${dollars(cents)}`);

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function newSecret(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

export function hashKey(key: string): string {
  return sha256Hex("cb-key:" + key);
}
