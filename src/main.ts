import { createApp } from "./app.js";
import { config } from "./config.js";
import { getDb } from "./db.js";
import { paypalConfigured } from "./paypal/index.js";
import { providerLabel } from "./ai/provider.js";
import { telephonyReady } from "./voice/telephony.js";
import { startInlineWorker } from "./worker.js";

const db = await getDb();
const app = createApp();
app.listen(config.port, () => {
  console.log(`Callback on ${config.appUrl} (port ${config.port}) · db ${db.kind} · PayPal ${paypalConfigured() ? config.paypal.env : "not configured"} · brain ${providerLabel()} · phone ${telephonyReady() ? "Twilio" : "simulator"}`);
});
if (config.inlineWorker) startInlineWorker(db, config.workerIntervalMs);
