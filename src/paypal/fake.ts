import { randomBytes } from "node:crypto";
import { OrderInput, PayPalApi, PayPalError, PlanInput, PPAuthorization, PPBalance, PPCapture, PPInvoice, PPOrder, PPRefund, PPSubscription, PPTransaction, SubscriptionInput, toValue, UnknownOutcomeError } from "./types.js";

const rid = (p: string) => `${p}${randomBytes(6).toString("hex").toUpperCase()}`;

type FakeOrder = PPOrder & { cents: number; currency: string; customId: string; intent?: "CAPTURE" | "AUTHORIZE" };
type FakeCapture = PPCapture & { refundedCents: number; cents: number };

/** In-memory PayPal: orders, captures, refunds, invoices, products, plans, subscriptions. Idempotent on PayPal-Request-Id. */
export class FakePayPal implements PayPalApi {
  readonly env = "sandbox" as const;
  orders = new Map<string, FakeOrder>();
  captures = new Map<string, FakeCapture>();
  authorizations = new Map<string, PPAuthorization & { cents: number }>();
  refunds = new Map<string, PPRefund & { captureId: string }>();
  invoices = new Map<string, PPInvoice & { recipient: string }>();
  products = new Set<string>();
  plans = new Map<string, PlanInput & { id: string }>();
  subs = new Map<string, PPSubscription>();
  simulatedEvents: { webhookId: string; eventType: string }[] = [];
  bodies: { method: string; body: unknown }[] = [];
  calls: string[] = [];
  private idem = new Map<string, unknown>();
  private fail = new Map<string, Error>();
  private lose = new Set<string>();

  constructor(private readonly approveBase = "http://fake.paypal.local") {}

  failNext(method: string, err: Error = new PayPalError("Service unavailable", 503, "SERVICE_UNAVAILABLE", "fake", null)) {
    this.fail.set(method, err);
  }
  loseResponseNext(method: string) {
    this.lose.add(method);
  }
  approveOrder(id: string) {
    const o = this.orders.get(id);
    if (!o) throw new Error("no order");
    o.status = "APPROVED";
  }
  payInvoice(id: string) {
    const inv = this.invoices.get(id);
    if (inv) inv.status = "PAID";
  }
  activateSubscription(id: string) {
    const s = this.subs.get(id);
    if (s) s.status = "ACTIVE";
  }

  private async run<T>(method: string, requestId: string | null, fn: () => T): Promise<T> {
    this.calls.push(method);
    const f = this.fail.get(method);
    if (f) {
      this.fail.delete(method);
      throw f;
    }
    let out: T;
    if (requestId && this.idem.has(requestId)) out = this.idem.get(requestId) as T;
    else {
      out = fn();
      if (requestId) this.idem.set(requestId, out);
    }
    if (this.lose.has(method)) {
      this.lose.delete(method);
      throw new UnknownOutcomeError(`Simulated lost response for ${method}`);
    }
    return JSON.parse(JSON.stringify(out));
  }

  private notFound(what: string): never {
    throw new PayPalError(`${what} not found`, 404, "RESOURCE_NOT_FOUND", "fake", null);
  }

  private newCapture(o: FakeOrder): FakeCapture {
    const fee = Math.round(o.cents * 0.039) + 30;
    const c: FakeCapture = { id: rid("CA"), status: "COMPLETED", amount: { value: toValue(o.cents), currency_code: o.currency }, custom_id: o.customId, refundedCents: 0, cents: o.cents, seller_receivable_breakdown: { gross_amount: { value: toValue(o.cents), currency_code: o.currency }, paypal_fee: { value: toValue(fee), currency_code: o.currency }, net_amount: { value: toValue(o.cents - fee), currency_code: o.currency } } };
    this.captures.set(c.id, c);
    o.status = "COMPLETED";
    o.purchase_units = [{ reference_id: o.customId, custom_id: o.customId, amount: c.amount, payments: { captures: [{ id: c.id, status: c.status, amount: c.amount, custom_id: c.custom_id }] } }];
    return c;
  }

  private newAuthorization(o: FakeOrder) {
    const a = { id: rid("AU"), status: "CREATED" as const, amount: { value: toValue(o.cents), currency_code: o.currency }, custom_id: o.customId, expiration_time: new Date(Date.now() + 29 * 86400_000).toISOString(), cents: o.cents };
    this.authorizations.set(a.id, a);
    o.status = "COMPLETED";
    o.purchase_units = [{ reference_id: o.customId, custom_id: o.customId, amount: a.amount, payments: { authorizations: [{ id: a.id, status: a.status, amount: a.amount, custom_id: a.custom_id, expiration_time: a.expiration_time }] } }];
    return a;
  }

  async authorizeOrder(id: string, requestId: string) {
    this.bodies.push({ method: "authorizeOrder", body: { id } });
    return this.run("authorizeOrder", requestId, () => {
      const o = this.orders.get(id) ?? this.notFound("Order");
      if (o.intent !== "AUTHORIZE") throw new PayPalError("Order intent is CAPTURE", 422, "ACTION_DOES_NOT_MATCH_INTENT", "fake", null);
      if (o.status !== "APPROVED") throw new PayPalError("Payer has not approved the order", 422, "ORDER_NOT_APPROVED", "fake", null);
      this.newAuthorization(o);
      return { id: o.id, status: o.status, purchase_units: o.purchase_units } as PPOrder;
    });
  }
  async getAuthorization(id: string) {
    return this.run("getAuthorization", null, () => {
      const a = this.authorizations.get(id) ?? this.notFound("Authorization");
      return { id: a.id, status: a.status, amount: a.amount, custom_id: a.custom_id, expiration_time: a.expiration_time };
    });
  }
  async captureAuthorization(authorizationId: string, amountCents: number, currency: string, requestId: string) {
    this.bodies.push({ method: "captureAuthorization", body: { authorizationId, amountCents } });
    return this.run("captureAuthorization", requestId, () => {
      const a = this.authorizations.get(authorizationId) ?? this.notFound("Authorization");
      if (a.status !== "CREATED") throw new PayPalError(`Authorization is ${a.status}`, 422, "AUTHORIZATION_ALREADY_CAPTURED", "fake", null);
      if (amountCents > a.cents) throw new PayPalError("Amount above the authorization", 422, "CANNOT_CAPTURE_MORE_THAN_AUTHORIZED", "fake", null);
      a.status = "CAPTURED";
      const fee = Math.round(amountCents * 0.039) + 30;
      const c: FakeCapture = { id: rid("CA"), status: "COMPLETED", amount: { value: toValue(amountCents), currency_code: currency }, custom_id: a.custom_id, refundedCents: 0, cents: amountCents, seller_receivable_breakdown: { gross_amount: { value: toValue(amountCents), currency_code: currency }, paypal_fee: { value: toValue(fee), currency_code: currency }, net_amount: { value: toValue(amountCents - fee), currency_code: currency } } };
      this.captures.set(c.id, c);
      return { id: c.id, status: c.status, amount: c.amount, custom_id: c.custom_id } as PPCapture;
    });
  }
  async voidAuthorization(authorizationId: string, requestId: string) {
    this.bodies.push({ method: "voidAuthorization", body: { authorizationId } });
    await this.run("voidAuthorization", requestId, () => {
      const a = this.authorizations.get(authorizationId) ?? this.notFound("Authorization");
      if (a.status !== "CREATED") throw new PayPalError(`Authorization is ${a.status}`, 422, "PREVIOUSLY_VOIDED", "fake", null);
      a.status = "VOIDED";
      return null;
    });
  }

  async verifyCredentials() {
    return this.run("verifyCredentials", null, () => ({ appId: "FAKE", scopes: ["payments", "invoicing", "subscriptions"] }));
  }

  async createOrder(input: OrderInput & { returnUrl: string }, requestId: string) {
    this.bodies.push({ method: "createOrder", body: input });
    return this.run("createOrder", requestId, () => {
      const id = rid("OR");
      this.orders.set(id, { id, status: "PAYER_ACTION_REQUIRED", cents: input.amountCents, currency: input.currency, customId: input.customId, intent: input.intent ?? "CAPTURE", purchase_units: [{ custom_id: input.customId, amount: { value: toValue(input.amountCents), currency_code: input.currency } }] });
      return { id, status: "PAYER_ACTION_REQUIRED", approveUrl: `${this.approveBase}/checkout?token=${id}&return=${encodeURIComponent(input.returnUrl)}` };
    });
  }

  /** Vault ids the fake accepts; anything else is refused like PayPal refuses a removed token. */
  vaultIds = new Set<string>(["FAKE-VAULT-TOKEN"]);
  async createVaultOrder(input: OrderInput & { vaultId: string }, requestId: string) {
    this.bodies.push({ method: "createVaultOrder", body: input });
    return this.run("createVaultOrder", requestId, () => {
      if (!this.vaultIds.has(input.vaultId)) throw new PayPalError("The specified payment token was not found", 422, "INVALID_PAYMENT_TOKEN", "fake", null);
      const id = rid("OR");
      const o: FakeOrder = { id, status: "CREATED", cents: input.amountCents, currency: input.currency, customId: input.customId, intent: input.intent ?? "CAPTURE" };
      this.orders.set(id, o);
      if (o.intent === "AUTHORIZE") this.newAuthorization(o);
      else this.newCapture(o);
      return { id, status: "COMPLETED" };
    });
  }
  async getPaymentToken(id: string) {
    return this.run("getPaymentToken", null, () => (this.vaultIds.has(id) ? { id, customer: { id: "FAKECUST" }, payment_source: { paypal: { email_address: "buyer@example.com" } } } : this.notFound("Payment token")));
  }
  async createSetupToken(_input: { returnUrl: string; cancelUrl: string }, requestId: string) {
    return this.run("createSetupToken", requestId, () => ({ id: rid("ST"), approveUrl: `${this.approveBase}/vault/approve` }));
  }
  async createPaymentToken(setupTokenId: string, requestId: string) {
    return this.run("createPaymentToken", requestId, () => {
      const id = `PT${setupTokenId}`;
      this.vaultIds.add(id);
      return { id, customer: { id: "FAKECUST" } };
    });
  }

  async getOrder(id: string) {
    return this.run("getOrder", null, () => {
      const o = this.orders.get(id) ?? this.notFound("Order");
      return { id: o.id, status: o.status, purchase_units: o.purchase_units } as PPOrder;
    });
  }

  async captureOrder(id: string, requestId: string) {
    return this.run("captureOrder", requestId, () => {
      const o = this.orders.get(id) ?? this.notFound("Order");
      if (o.status === "COMPLETED") throw new PayPalError("Order already captured", 422, "ORDER_ALREADY_CAPTURED", "fake", null);
      if (o.status !== "APPROVED") throw new PayPalError("Payer has not approved the order", 422, "ORDER_NOT_APPROVED", "fake", null);
      this.newCapture(o);
      return { id: o.id, status: o.status, purchase_units: o.purchase_units } as PPOrder;
    });
  }

  async getCapture(id: string) {
    return this.run("getCapture", null, () => {
      const c = this.captures.get(id) ?? this.notFound("Capture");
      return { id: c.id, status: c.status, amount: c.amount, custom_id: c.custom_id, seller_receivable_breakdown: c.seller_receivable_breakdown };
    });
  }

  async refundCapture(captureId: string, amountCents: number | null, currency: string, _note: string, requestId: string) {
    this.bodies.push({ method: "refundCapture", body: { captureId, amountCents } });
    return this.run("refundCapture", requestId, () => {
      const c = this.captures.get(captureId) ?? this.notFound("Capture");
      const left = c.cents - c.refundedCents;
      const amt = amountCents ?? left;
      if (amt <= 0 || amt > left) throw new PayPalError("Refund amount exceeds the remaining capture", 422, "REFUND_AMOUNT_EXCEEDED", "fake", null);
      c.refundedCents += amt;
      c.status = c.refundedCents >= c.cents ? "REFUNDED" : "PARTIALLY_REFUNDED";
      const r = { id: rid("RF"), status: "COMPLETED" as PPRefund["status"], amount: { value: toValue(amt), currency_code: currency }, captureId };
      this.refunds.set(r.id, r);
      return { id: r.id, status: r.status, amount: r.amount };
    });
  }

  async getRefund(id: string) {
    return this.run("getRefund", null, () => {
      const r = this.refunds.get(id) ?? this.notFound("Refund");
      return { id: r.id, status: r.status, amount: r.amount };
    });
  }

  async createInvoice(input: { recipientEmail: string; amountCents: number; currency: string; description: string; reference: string }, requestId: string) {
    this.bodies.push({ method: "createInvoice", body: input });
    return this.run("createInvoice", requestId, () => {
      const id = `INV2-${rid("")}`;
      const inv = { id, status: "DRAFT" as const, amount: { value: toValue(input.amountCents), currency_code: input.currency }, href: `${this.approveBase}/invoice/${id}`, recipient: input.recipientEmail };
      this.invoices.set(id, inv);
      return { id: inv.id, status: inv.status, amount: inv.amount, href: inv.href } as PPInvoice;
    });
  }

  async sendInvoice(invoiceId: string, requestId: string) {
    await this.run("sendInvoice", requestId, () => {
      const inv = this.invoices.get(invoiceId) ?? this.notFound("Invoice");
      if (inv.status === "DRAFT") inv.status = "SENT";
      return null;
    });
  }

  async getInvoice(id: string) {
    return this.run("getInvoice", null, () => {
      const inv = this.invoices.get(id) ?? this.notFound("Invoice");
      return { id: inv.id, status: inv.status, amount: inv.amount, href: inv.href } as PPInvoice;
    });
  }

  async listInvoices() {
    return this.run("listInvoices", null, () => [...this.invoices.values()].map(({ recipient: _r, ...i }) => i));
  }

  async createProduct(name: string, requestId: string) {
    return this.run("createProduct", requestId, () => {
      const id = rid("PROD-");
      this.products.add(id);
      void name;
      return { id };
    });
  }

  async createPlan(input: PlanInput, requestId: string) {
    this.bodies.push({ method: "createPlan", body: input });
    return this.run("createPlan", requestId, () => {
      if (!this.products.has(input.productId)) throw new PayPalError("Product not found", 422, "INVALID_RESOURCE_ID", "fake", null);
      const id = rid("P-");
      this.plans.set(id, { ...input, id });
      return { id, status: "ACTIVE" };
    });
  }

  async createSubscription(input: SubscriptionInput, requestId: string) {
    this.bodies.push({ method: "createSubscription", body: input });
    return this.run("createSubscription", requestId, () => {
      if (!this.plans.has(input.planId)) throw new PayPalError("Plan not found", 422, "INVALID_PLAN", "fake", null);
      const id = rid("I-");
      const approve = `${this.approveBase}/subscribe?token=${id}&return=${encodeURIComponent(input.returnUrl)}`;
      this.subs.set(id, { id, status: "APPROVAL_PENDING", plan_id: input.planId, custom_id: input.customId, billing_info: { outstanding_balance: { value: "0.00", currency_code: "USD" }, failed_payments_count: 0, cycle_executions: [{ tenure_type: "REGULAR", cycles_completed: 0, total_cycles: this.plans.get(input.planId)!.totalCycles }] }, links: [{ rel: "approve", href: approve }] });
      return { id, status: "APPROVAL_PENDING", approveUrl: approve };
    });
  }

  async getSubscription(id: string) {
    return this.run("getSubscription", null, () => this.subs.get(id) ?? this.notFound("Subscription"));
  }

  async cancelSubscription(id: string, _reason: string, requestId: string) {
    await this.run("cancelSubscription", requestId, () => {
      const s = this.subs.get(id) ?? this.notFound("Subscription");
      s.status = "CANCELLED";
      return null;
    });
  }

  async searchTransactions(_input: { start: Date; end: Date }) {
    return this.run("searchTransactions", null, () => {
      const out: PPTransaction[] = [];
      for (const c of this.captures.values()) out.push({ transaction_id: c.id, transaction_status: "S", transaction_amount: c.amount, transaction_initiation_date: new Date().toISOString(), event_code: "T0006", custom_field: c.custom_id });
      for (const r of this.refunds.values()) out.push({ transaction_id: r.id, transaction_status: "S", transaction_amount: { value: "-" + (r.amount?.value ?? "0.00"), currency_code: r.amount?.currency_code ?? "USD" }, transaction_initiation_date: new Date().toISOString(), event_code: "T1107" });
      return out;
    });
  }

  async listBalances() {
    return this.run("listBalances", null, () => {
      let cents = 0;
      for (const c of this.captures.values()) cents += c.cents - c.refundedCents;
      return [{ currency: "USD", total_balance: { value: toValue(cents), currency_code: "USD" }, available_balance: { value: toValue(cents), currency_code: "USD" } }] as PPBalance[];
    });
  }

  async simulateWebhookEvent(webhookId: string, eventType: string) {
    this.simulatedEvents.push({ webhookId, eventType });
    return { id: `WH-EVT-${this.simulatedEvents.length}` };
  }
  async createWebhook(url: string) {
    return { id: `WH-FAKE-${url.length}` };
  }
  async listWebhooks() {
    return [];
  }
  async verifyWebhookSignature(headers: Record<string, string | undefined>) {
    return headers["paypal-transmission-sig"] === "valid-fake-signature";
  }
}
