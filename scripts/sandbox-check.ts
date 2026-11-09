/** Verifies the PayPal sandbox credentials and scopes, creates (and lists) the webhook when APP_URL is public. */
import { config } from "../src/config.js";
import { paypal, paypalConfigured, WEBHOOK_EVENTS } from "../src/paypal/index.js";

if (!paypalConfigured()) {
  console.log("PayPal is not configured (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET). Pages run; money moves fail honestly.");
  process.exit(0);
}
const pp = paypal();
const v = await pp.verifyCredentials();
console.log(`Credentials ok (${config.paypal.env}). Scopes: ${v.scopes.slice(0, 8).join(", ")}${v.scopes.length > 8 ? "…" : ""}`);
const need = ["invoicing", "subscriptions", "payments"];
for (const n of need) console.log(`  ${v.scopes.some((s) => s.includes(n)) ? "✓" : "✗"} ${n}`);
const hooks = await pp.listWebhooks();
const url = `${config.appUrl}/webhooks/paypal`;
const have = hooks.find((h) => h.url === url);
if (have) console.log(`Webhook present: ${have.id} → ${url}`);
else if (/localhost|127\.0\.0\.1/.test(config.appUrl)) console.log(`Skipping webhook creation: APP_URL is local (${config.appUrl}).`);
else {
  const w = await pp.createWebhook(url, WEBHOOK_EVENTS);
  console.log(`Webhook created: ${w.id} → ${url}. Set PAYPAL_WEBHOOK_ID=${w.id}`);
}
const bal = await pp.listBalances().catch((e) => (console.log(`Balances: ${(e as Error).message}`), []));
if (bal.length) console.log(`Balances: ${bal.map((b) => `${b.currency} ${b.total_balance.value}`).join(", ")}`);
