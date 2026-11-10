import { config } from "../config.js";
import { getDb } from "../db.js";
import { PayPalClient } from "./client.js";
import { PayPalApi, PayPalError, UnknownOutcomeError } from "./types.js";

let instance: PayPalApi | null = null;
let override: PayPalApi | null = null;

function base(): PayPalApi {
  if (override) return override;
  if (instance) return instance;
  if (!config.paypal.clientId || !config.paypal.clientSecret) throw new Error("PayPal credentials are not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.");
  instance = new PayPalClient({ clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, env: config.paypal.env });
  return instance;
}

export type FaultKind = "fail_503" | "lose_response";
export const FAULTABLE = ["createOrder", "createVaultOrder", "captureOrder", "refundCapture", "createInvoice", "createSubscription"] as const;

/** Every PayPal method that writes money state. The structural test checks each call site sits behind the gate. */
export const PAYPAL_WRITES = ["createOrder", "createVaultOrder", "captureOrder", "refundCapture", "createInvoice", "sendInvoice", "createProduct", "createPlan", "createSubscription", "cancelSubscription"] as const;

async function takeFault(method: string): Promise<FaultKind | null> {
  if (!config.demoMode) return null;
  const db = await getDb();
  const r = await db.query<{ kind: FaultKind }>("DELETE FROM demo_faults WHERE id = (SELECT id FROM demo_faults WHERE method = $1 ORDER BY id LIMIT 1) RETURNING kind", [method]);
  return r.rows[0]?.kind ?? null;
}

export async function armFault(method: string, kind: FaultKind) {
  const db = await getDb();
  await db.query("INSERT INTO demo_faults (method, kind) VALUES ($1,$2)", [method, kind]);
}

function withFaults(p: PayPalApi): PayPalApi {
  return new Proxy(p, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== "function" || !(FAULTABLE as readonly string[]).includes(String(prop))) return typeof v === "function" ? v.bind(target) : v;
      return async (...args: unknown[]) => {
        const fault = await takeFault(String(prop));
        if (fault === "fail_503") throw new PayPalError("Injected fault: PayPal unavailable (503)", 503, "SERVICE_UNAVAILABLE", "injected", null);
        const out = await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        if (fault === "lose_response") throw new UnknownOutcomeError("Injected fault: PayPal completed the call but the response was lost");
        return out;
      };
    },
  });
}

export function paypal(): PayPalApi {
  return withFaults(base());
}

export function currentOverride(): PayPalApi | null {
  return override;
}

export function setPayPal(p: PayPalApi | null) {
  override = p;
}

export function paypalConfigured(): boolean {
  return Boolean(override || (config.paypal.clientId && config.paypal.clientSecret));
}

/** Negative-path testing (roadmap B.7): run `fn` while one PayPal method returns a canned response or throws. */
export async function withMockResponse<T>(method: keyof PayPalApi, mock: unknown | Error, fn: () => Promise<T>): Promise<T> {
  const real = base();
  const proxied = new Proxy(real, {
    get(target, prop, recv) {
      if (prop === method) {
        return async () => {
          if (mock instanceof Error) throw mock;
          return mock;
        };
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const prev = override;
  override = proxied;
  try {
    return await fn();
  } finally {
    override = prev;
  }
}

export { PayPalClient, WEBHOOK_EVENTS } from "./client.js";
export * from "./types.js";
