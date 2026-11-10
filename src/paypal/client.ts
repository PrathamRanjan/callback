import { paypalBaseUrl } from "../config.js";
import { OrderInput, PayPalApi, PayPalError, PlanInput, PPBalance, PPCapture, PPInvoice, PPOrder, PPRefund, PPSubscription, PPTransaction, SubscriptionInput, toValue, UnknownOutcomeError } from "./types.js";

type Json = Record<string, any>;

/** Typed PayPal REST client. Writes carry PayPal-Request-Id so a retry with the same id cannot apply twice. */
export class PayPalClient implements PayPalApi {
  private token: { value: string; expiresAt: number; scopes: string[]; appId?: string } | null = null;
  readonly env: "sandbox" | "live";

  constructor(private readonly creds: { clientId: string; clientSecret: string; env: "sandbox" | "live" }, private readonly fetchImpl: typeof fetch = (i, init) => fetch(i, init)) {
    this.env = creds.env;
  }

  private get base() {
    return paypalBaseUrl(this.env);
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const res = await this.fetchImpl(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const data = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) throw new PayPalError(String(data.error_description ?? "PayPal authentication failed"), res.status, String(data.error ?? ""), undefined, data);
    this.token = { value: String(data.access_token), expiresAt: Date.now() + Number(data.expires_in ?? 3000) * 1000, scopes: String(data.scope ?? "").split(" ").filter(Boolean), appId: data.app_id };
    return this.token.value;
  }

  private async call<T = Json>(method: string, path: string, body?: unknown, opts: { requestId?: string; prefer?: string } = {}): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json", Accept: "application/json" };
    if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;
    if (opts.prefer) headers["Prefer"] = opts.prefer;
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      } catch (e) {
        last = new UnknownOutcomeError(`Network error calling PayPal ${method} ${path}: ${(e as Error).message}`);
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        throw last;
      }
      const text = await res.text();
      const data = (text ? JSON.parse(text) : {}) as any;
      if (res.status >= 500 && attempt < 2) {
        last = new PayPalError(data.message ?? `PayPal ${res.status}`, res.status, data.name, data.debug_id, data.details);
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      if (res.status === 429 || /PREVIOUS_REQUEST_IN_PROGRESS/.test(`${data.name ?? ""} ${JSON.stringify(data.details ?? "")}`)) {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        throw new UnknownOutcomeError(`PayPal is still processing ${method} ${path} (outcome unknown; retry with the same request id)`);
      }
      if (!res.ok) {
        const d = Array.isArray(data.details) && data.details[0] ? `: ${data.details[0].issue ?? ""} ${data.details[0].description ?? ""}`.trim() : "";
        throw new PayPalError(`${data.message ?? data.name ?? `PayPal ${res.status}`}${d}`, res.status, data.name ?? data.details?.[0]?.issue, data.debug_id, data.details);
      }
      return data as T;
    }
    throw last;
  }

  async verifyCredentials() {
    await this.accessToken();
    return { appId: this.token?.appId, scopes: this.token?.scopes ?? [] };
  }

  async createOrder(input: OrderInput & { returnUrl: string; cancelUrl: string }, requestId: string) {
    const d = await this.call<PPOrder>(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [{ reference_id: input.customId, custom_id: input.customId, description: input.description.slice(0, 127), amount: { currency_code: input.currency, value: toValue(input.amountCents) } }],
        payment_source: { paypal: { experience_context: { brand_name: (input.brand ?? "Callback").slice(0, 127), user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING", return_url: input.returnUrl, cancel_url: input.cancelUrl } } },
      },
      { requestId, prefer: "return=representation" },
    );
    const approve = d.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href ?? null;
    return { id: d.id, status: d.status, approveUrl: approve };
  }

  async getOrder(id: string) {
    return this.call<PPOrder>("GET", `/v2/checkout/orders/${encodeURIComponent(id)}`);
  }

  async captureOrder(id: string, requestId: string) {
    return this.call<PPOrder>("POST", `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {}, { requestId, prefer: "return=representation" });
  }

  async getCapture(id: string) {
    return this.call<PPCapture>("GET", `/v2/payments/captures/${encodeURIComponent(id)}`);
  }

  async refundCapture(captureId: string, amountCents: number | null, currency: string, note: string, requestId: string) {
    const body: Json = { note_to_payer: note.slice(0, 255) };
    if (amountCents !== null) body.amount = { value: toValue(amountCents), currency_code: currency };
    return this.call<PPRefund>("POST", `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, body, { requestId, prefer: "return=representation" });
  }

  async getRefund(id: string) {
    return this.call<PPRefund>("GET", `/v2/payments/refunds/${encodeURIComponent(id)}`);
  }

  async createInvoice(input: { recipientEmail: string; amountCents: number; currency: string; description: string; reference: string; dueDays?: number; businessName?: string }, requestId: string): Promise<PPInvoice> {
    const d = await this.call<Json>(
      "POST",
      "/v2/invoicing/invoices",
      {
        detail: { currency_code: input.currency, reference: input.reference.slice(0, 120), note: input.description.slice(0, 4000), ...invoiceDates(input.dueDays) },
        invoicer: { business_name: (input.businessName || "Callback").slice(0, 300) },
        primary_recipients: [{ billing_info: { email_address: input.recipientEmail } }],
        items: [{ name: input.description.slice(0, 200), quantity: "1", unit_amount: { currency_code: input.currency, value: toValue(input.amountCents) } }],
      },
      { requestId, prefer: "return=representation" },
    );
    return { id: String(d.id), status: d.status ?? "DRAFT", amount: d.amount, href: d.href };
  }

  async sendInvoice(invoiceId: string, requestId: string) {
    await this.call<Json>("POST", `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`, { send_to_invoicer: false }, { requestId });
  }

  async getInvoice(id: string): Promise<PPInvoice> {
    const d = await this.call<Json>("GET", `/v2/invoicing/invoices/${encodeURIComponent(id)}`);
    return { id: String(d.id), status: d.status, amount: d.amount, href: d.href };
  }

  async listInvoices(): Promise<PPInvoice[]> {
    const d = await this.call<{ items?: Json[] }>("GET", "/v2/invoicing/invoices?page_size=50&total_required=true");
    return (d.items ?? []).map((i) => ({ id: String(i.id), status: i.status, amount: i.amount, href: i.href }));
  }

  async createProduct(name: string, requestId: string) {
    const d = await this.call<Json>("POST", "/v1/catalogs/products", { name: name.slice(0, 127), type: "SERVICE" }, { requestId });
    return { id: String(d.id) };
  }

  async createPlan(input: PlanInput, requestId: string) {
    const d = await this.call<Json>(
      "POST",
      "/v1/billing/plans",
      {
        product_id: input.productId,
        name: input.name.slice(0, 127),
        description: (input.description || input.name).slice(0, 127),
        status: "ACTIVE",
        billing_cycles: [{ frequency: { interval_unit: input.intervalUnit, interval_count: input.intervalCount }, tenure_type: "REGULAR", sequence: 1, total_cycles: input.totalCycles, pricing_scheme: { fixed_price: { value: input.price, currency_code: input.currency } } }],
        payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: "CONTINUE", payment_failure_threshold: 2 },
      },
      { requestId, prefer: "return=representation" },
    );
    return { id: String(d.id), status: String(d.status) };
  }

  async createSubscription(input: SubscriptionInput, requestId: string) {
    const subscriber: Json = {};
    if (input.subscriberEmail) subscriber.email_address = input.subscriberEmail;
    if (input.subscriberName) {
      const [given, ...rest] = input.subscriberName.trim().split(/\s+/);
      subscriber.name = { given_name: given, surname: rest.join(" ") || undefined };
    }
    const d = await this.call<PPSubscription>(
      "POST",
      "/v1/billing/subscriptions",
      { plan_id: input.planId, custom_id: input.customId, subscriber: Object.keys(subscriber).length ? subscriber : undefined, application_context: { brand_name: input.brandName.slice(0, 127), shipping_preference: "NO_SHIPPING", user_action: "SUBSCRIBE_NOW", return_url: input.returnUrl, cancel_url: input.cancelUrl } },
      { requestId, prefer: "return=representation" },
    );
    return { id: d.id, status: d.status, approveUrl: d.links?.find((l) => l.rel === "approve")?.href ?? null };
  }

  async getSubscription(id: string) {
    return this.call<PPSubscription>("GET", `/v1/billing/subscriptions/${encodeURIComponent(id)}`);
  }

  async cancelSubscription(id: string, reason: string, requestId: string) {
    await this.call<Json>("POST", `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, { reason: reason.slice(0, 127) }, { requestId });
  }

  async searchTransactions(input: { start: Date; end: Date; fields?: string }) {
    const q = new URLSearchParams({ start_date: input.start.toISOString().replace(/\.\d{3}Z$/, "-0000"), end_date: input.end.toISOString().replace(/\.\d{3}Z$/, "-0000"), fields: input.fields ?? "transaction_info,payer_info", page_size: "100" });
    const d = await this.call<{ transaction_details?: { transaction_info: Json; payer_info?: Json }[] }>("GET", `/v1/reporting/transactions?${q}`);
    return (d.transaction_details ?? []).map((t) => ({ ...(t.transaction_info as PPTransaction), payer_email: t.payer_info?.email_address }));
  }

  async listBalances() {
    const d = await this.call<{ balances?: PPBalance[] }>("GET", "/v1/reporting/balances");
    return d.balances ?? [];
  }

  async simulateWebhookEvent(webhookId: string, eventType: string) {
    // Subscription events only exist in resource version 2.0; without it PayPal answers "Not a valid Resource Type".
    const body: Record<string, string> = { webhook_id: webhookId, event_type: eventType };
    if (eventType.startsWith("BILLING.SUBSCRIPTION.")) body.resource_version = "2.0";
    const d = await this.call<{ id: string }>("POST", "/v1/notifications/simulate-event", body);
    return { id: d.id };
  }

  async createWebhook(url: string, eventTypes: string[]) {
    const d = await this.call<{ id: string }>("POST", "/v1/notifications/webhooks", { url, event_types: eventTypes.map((name) => ({ name })) });
    return { id: d.id };
  }

  async listWebhooks() {
    const d = await this.call<{ webhooks: { id: string; url: string }[] }>("GET", "/v1/notifications/webhooks");
    return d.webhooks ?? [];
  }

  async verifyWebhookSignature(headers: Record<string, string | undefined>, body: unknown, webhookId: string) {
    const d = await this.call<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: headers["paypal-auth-algo"],
      cert_url: headers["paypal-cert-url"],
      transmission_id: headers["paypal-transmission-id"],
      transmission_sig: headers["paypal-transmission-sig"],
      transmission_time: headers["paypal-transmission-time"],
      webhook_id: webhookId,
      webhook_event: body,
    });
    return d.verification_status === "SUCCESS";
  }
}

/**
 * Invoice dates. PayPal only accepts NET_10/15/30/45/60/90 as term types, so any other number of days becomes an
 * exact due date (DUE_ON_DATE_SPECIFIED). "NET_7" used to be sent and PayPal rejected every invoice as malformed.
 */
const NET_TERMS = new Set([10, 15, 30, 45, 60, 90]);
export function invoiceDates(dueDays?: number, now = new Date()) {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  if (!dueDays || dueDays <= 0) return { invoice_date: day(now), payment_term: { term_type: "DUE_ON_RECEIPT" } };
  if (NET_TERMS.has(dueDays)) return { invoice_date: day(now), payment_term: { term_type: `NET_${dueDays}` } };
  return { invoice_date: day(now), payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: day(new Date(now.getTime() + dueDays * 86_400_000)) } };
}

export const WEBHOOK_EVENTS = ["CHECKOUT.ORDER.APPROVED", "PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REFUNDED", "INVOICING.INVOICE.PAID", "INVOICING.INVOICE.CANCELLED", "BILLING.SUBSCRIPTION.ACTIVATED", "BILLING.SUBSCRIPTION.CANCELLED", "BILLING.SUBSCRIPTION.PAYMENT.FAILED", "PAYMENT.SALE.COMPLETED"];
