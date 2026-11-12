export interface PPMoney {
  value: string;
  currency_code: string;
}

export interface PPCapture {
  id: string;
  status: "COMPLETED" | "DECLINED" | "PARTIALLY_REFUNDED" | "PENDING" | "REFUNDED" | "FAILED";
  amount: PPMoney;
  custom_id?: string;
  seller_receivable_breakdown?: { gross_amount?: PPMoney; paypal_fee?: PPMoney; net_amount?: PPMoney };
}

export interface PPRefund {
  id: string;
  status: "CANCELLED" | "FAILED" | "PENDING" | "COMPLETED";
  amount?: PPMoney;
}

export interface PPOrder {
  id: string;
  status: "CREATED" | "SAVED" | "APPROVED" | "VOIDED" | "COMPLETED" | "PAYER_ACTION_REQUIRED";
  purchase_units?: { reference_id?: string; custom_id?: string; amount?: PPMoney; payments?: { captures?: PPCapture[]; refunds?: PPRefund[]; authorizations?: PPAuthorization[] } }[];
  links?: { href: string; rel: string; method?: string }[];
}

export interface OrderInput {
  amountCents: number;
  currency: string;
  customId: string;
  description: string;
  brand?: string;
  /** PayPal checkout page language (BCP 47, e.g. "pt-BR"). Left out for English, so English orders are unchanged. */
  locale?: string;
  /** CAPTURE (default): paid now. AUTHORIZE: a hold on the payer's funds, captured or voided later (spec B2 item 3). */
  intent?: "CAPTURE" | "AUTHORIZE";
}

/** An authorization (a hold): CREATED until captured or voided; PayPal lets it be captured for up to 29 days. */
export interface PPAuthorization {
  id: string;
  status: "CREATED" | "CAPTURED" | "DENIED" | "PARTIALLY_CAPTURED" | "VOIDED" | "PENDING" | "EXPIRED";
  amount: PPMoney;
  custom_id?: string;
  expiration_time?: string;
}

export interface PPInvoice {
  id: string;
  status: "DRAFT" | "SENT" | "SCHEDULED" | "PAID" | "MARKED_AS_PAID" | "CANCELLED" | "REFUNDED" | "PARTIALLY_PAID" | "PARTIALLY_REFUNDED" | "MARKED_AS_REFUNDED" | "UNPAID" | "PAYMENT_PENDING";
  amount?: PPMoney;
  href?: string;
}

export type IntervalUnit = "DAY" | "WEEK" | "MONTH" | "YEAR";
export interface PlanInput {
  productId: string;
  name: string;
  description: string;
  price: string;
  currency: string;
  intervalUnit: IntervalUnit;
  intervalCount: number;
  /** Number of instalments; 0 = until cancelled. */
  totalCycles: number;
}
export interface SubscriptionInput {
  planId: string;
  customId: string;
  brandName: string;
  returnUrl: string;
  cancelUrl: string;
  subscriberEmail?: string;
  subscriberName?: string;
}
export interface PPSubscription {
  id: string;
  status: "APPROVAL_PENDING" | "APPROVED" | "ACTIVE" | "SUSPENDED" | "CANCELLED" | "EXPIRED";
  plan_id: string;
  custom_id?: string;
  billing_info?: { outstanding_balance?: PPMoney; next_billing_time?: string; last_payment?: { amount: PPMoney; time: string }; failed_payments_count?: number; cycle_executions?: { tenure_type: string; cycles_completed: number; total_cycles?: number }[] };
  links?: { href: string; rel: string; method?: string }[];
}

export interface PPTransaction {
  transaction_id: string;
  transaction_status: string;
  transaction_amount: PPMoney;
  transaction_initiation_date: string;
  event_code?: string;
  custom_field?: string;
  payer_email?: string;
}
export interface PPBalance {
  currency: string;
  total_balance: PPMoney;
  available_balance?: PPMoney;
}

export interface PayPalApi {
  readonly env: "sandbox" | "live";
  verifyCredentials(): Promise<{ appId?: string; scopes: string[] }>;
  /** Pay link: a buyer-approved order (intent CAPTURE) the customer opens from the SMS or Telegram message. */
  createOrder(input: OrderInput & { returnUrl: string; cancelUrl: string }, requestId: string): Promise<{ id: string; status: string; approveUrl: string | null }>;
  /** Saved-wallet payment (demo only): an order paid from a vaulted PayPal wallet with no buyer login. Intent CAPTURE
   * completes at once; the caller still reads the order back before changing any state. */
  createVaultOrder(input: OrderInput & { vaultId: string }, requestId: string): Promise<{ id: string; status: string }>;
  /** Vault v3: the saved wallet's payment token (health check) and the one-time setup to replace it. */
  getPaymentToken(id: string): Promise<{ id: string; customer?: { id?: string }; payment_source?: { paypal?: { email_address?: string } } }>;
  createSetupToken(input: { returnUrl: string; cancelUrl: string }, requestId: string): Promise<{ id: string; approveUrl: string | null }>;
  createPaymentToken(setupTokenId: string, requestId: string): Promise<{ id: string; customer?: { id?: string } }>;
  getOrder(id: string): Promise<PPOrder>;
  captureOrder(id: string, requestId: string): Promise<PPOrder>;
  /** Holds (intent AUTHORIZE): authorize a buyer-approved order; then capture the authorization or void it. */
  authorizeOrder(id: string, requestId: string): Promise<PPOrder>;
  getAuthorization(id: string): Promise<PPAuthorization>;
  captureAuthorization(authorizationId: string, amountCents: number, currency: string, requestId: string): Promise<PPCapture>;
  voidAuthorization(authorizationId: string, requestId: string): Promise<void>;
  getCapture(id: string): Promise<PPCapture>;
  refundCapture(captureId: string, amountCents: number | null, currency: string, note: string, requestId: string): Promise<PPRefund>;
  getRefund(id: string): Promise<PPRefund>;
  /** Invoicing v2 for a balance the customer agreed to pay later. */
  createInvoice(input: { recipientEmail: string; amountCents: number; currency: string; description: string; reference: string; dueDays?: number; businessName?: string }, requestId: string): Promise<PPInvoice>;
  sendInvoice(invoiceId: string, requestId: string): Promise<void>;
  getInvoice(id: string): Promise<PPInvoice>;
  listInvoices(): Promise<PPInvoice[]>;
  /** Subscriptions: an instalment plan agreed on the call (fixed number of cycles). */
  createProduct(name: string, requestId: string): Promise<{ id: string }>;
  createPlan(input: PlanInput, requestId: string): Promise<{ id: string; status: string }>;
  createSubscription(input: SubscriptionInput, requestId: string): Promise<{ id: string; status: string; approveUrl: string | null }>;
  getSubscription(id: string): Promise<PPSubscription>;
  cancelSubscription(id: string, reason: string, requestId: string): Promise<void>;
  /** Reporting: the call planner's "what did PayPal see" view. */
  searchTransactions(input: { start: Date; end: Date; fields?: string }): Promise<PPTransaction[]>;
  listBalances(): Promise<PPBalance[]>;
  simulateWebhookEvent(webhookId: string, eventType: string): Promise<{ id: string }>;
  createWebhook(url: string, eventTypes: string[]): Promise<{ id: string }>;
  listWebhooks(): Promise<{ id: string; url: string }[]>;
  verifyWebhookSignature(headers: Record<string, string | undefined>, body: unknown, webhookId: string): Promise<boolean>;
}

export class PayPalError extends Error {
  constructor(message: string, readonly status: number, readonly name_: string | undefined, readonly debugId: string | undefined, readonly details: unknown) {
    super(message);
  }
  get isClientError() {
    return this.status >= 400 && this.status < 500;
  }
}

/** Network-level failure where the request may or may not have reached PayPal. */
export class UnknownOutcomeError extends Error {}

export const toValue = (cents: number) => (cents / 100).toFixed(2);
export const toCents = (m: PPMoney | undefined) => (m ? Math.round(Number(m.value) * 100) : 0);
export const firstCapture = (o: PPOrder) => o.purchase_units?.[0]?.payments?.captures?.[0] ?? null;
