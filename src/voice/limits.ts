/**
 * Who may start live voice, and how often (spec B2 item 1). "Call my phone" dials a number a visitor typed, so:
 * - only numbers in the countries the operator listed (CB_CALL_MY_PHONE_COUNTRIES; empty means the feature is off);
 * - one call per number per hour and five calls per address per day;
 * - every live session (phone, browser, test line) counts toward ten per address per day, because each minute costs.
 * Numbers and addresses are stored only as salted hashes, in the app's own registry (shared by every private demo,
 * so making a new demo does not reset the count).
 */
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { getDb, inWorkspace } from "../db.js";
import { GtError } from "../lib/util.js";

const hash = (kind: string, v: string) => createHash("sha256").update(`cb-live:${config.sessionSecret}:${kind}:${v}`).digest("hex").slice(0, 24);

/** Calling codes this check knows, longest first wins. A number whose code is not here is refused, never guessed. */
const CODES: [string, string][] = [
  ["1", "US"], ["44", "GB"], ["61", "AU"], ["64", "NZ"], ["65", "SG"], ["91", "IN"], ["81", "JP"], ["60", "MY"], ["62", "ID"], ["66", "TH"],
  ["353", "IE"], ["49", "DE"], ["33", "FR"], ["31", "NL"], ["34", "ES"], ["39", "IT"], ["852", "HK"], ["971", "AE"], ["63", "PH"], ["27", "ZA"],
];

export function normaliseNumber(raw: string): string | null {
  const s = String(raw ?? "").replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}
export function countryOf(e164: string): string | null {
  const digits = e164.slice(1);
  const hit = CODES.filter(([c]) => digits.startsWith(c)).sort((a, b) => b[0].length - a[0].length)[0];
  return hit ? hit[1] : null;
}

/** Throws a plain reason when this number may not be dialled; returns the normalised number otherwise. */
export function checkDialable(raw: string): string {
  const allowed = config.voice.callMyPhoneCountries;
  if (!allowed.length) throw new GtError("Call my phone is off on this deployment: the operator has not chosen which countries it may dial (CB_CALL_MY_PHONE_COUNTRIES). Talk in the browser or type instead.", "off", 403);
  const n = normaliseNumber(raw);
  if (!n) throw new GtError("Type the number in international form, starting with + and the country code (for example +61 4xx xxx xxx).", "bad_number");
  const cc = countryOf(n);
  if (!cc || !allowed.includes(cc)) throw new GtError(`This demo only dials numbers in ${allowed.join(", ")}.`, "country");
  return n;
}

async function count(key: string, window: string): Promise<number> {
  const db = await getDb();
  const r = await inWorkspace(null, () => db.query<{ n: number }>(`SELECT count(*)::int AS n FROM live_starts WHERE key = $1 AND at > now() - interval '${window}'`, [key]));
  return r.rows[0]?.n ?? 0;
}

/** Checks the limits for one live start and records it. `number` only for "call my phone". */
export async function takeLiveStart(transport: "phone" | "browser" | "test-line", ip: string, number: string | null = null) {
  const ipKey = hash("ip", ip || "unknown");
  if ((await count(ipKey, "1 day")) >= 10) throw new GtError("This address has started ten live voice calls today, the most the demo allows. Type instead, or come back tomorrow.", "rate_limited", 429);
  let numKey: string | null = null;
  let phoneIpKey: string | null = null;
  if (transport === "phone") {
    numKey = hash("number", number ?? "");
    phoneIpKey = hash("phone-ip", ip || "unknown");
    if ((await count(numKey, "1 hour")) >= 1) throw new GtError("That number was called in the last hour. The demo calls a number at most once an hour.", "rate_limited", 429);
    if ((await count(phoneIpKey, "1 day")) >= 5) throw new GtError("Five phone calls have been placed from this address today, the most the demo allows.", "rate_limited", 429);
  }
  const db = await getDb();
  await inWorkspace(null, async () => {
    await db.query("INSERT INTO live_starts (key, kind) VALUES ($1,'ip')", [ipKey]);
    if (numKey) await db.query("INSERT INTO live_starts (key, kind) VALUES ($1,'number')", [numKey]);
    if (phoneIpKey) await db.query("INSERT INTO live_starts (key, kind) VALUES ($1,'phone-ip')", [phoneIpKey]);
  });
  return { numberHash: numKey };
}

/** Push-to-talk dictation (Ask box): 30 a day per address, counted apart from calls. */
export async function takeDictationStart(ip: string) {
  const key = hash("dictation-ip", ip || "unknown");
  if ((await count(key, "1 day")) >= 30) throw new GtError("This address has used voice input thirty times today, the most the demo allows. Type instead.", "rate_limited", 429);
  const db = await getDb();
  await inWorkspace(null, () => db.query("INSERT INTO live_starts (key, kind) VALUES ($1,'dictation')", [key]));
}
