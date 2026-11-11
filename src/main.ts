import { createApp } from "./app.js";
import { config } from "./config.js";
import { getDb, inWorkspace, SCHEMA } from "./db.js";
import { paypalConfigured } from "./paypal/index.js";
import { providerLabel } from "./ai/provider.js";
import { syncThresholds } from "./ai/decisions.js";
import { telephonyReady } from "./voice/telephony.js";
import { startInlineWorker } from "./worker.js";
import { liveWorkspaces, rebuildShowcase, showcaseStale } from "./services/workspaces.js";

// Spec A11: the deployed server runs only with its keys. No key means no AI and no money, and nothing may stand in.
const deployed = process.env.NODE_ENV === "production" || process.env.RENDER === "true";
if (deployed) {
  const missing = [!config.ai.openaiKey && "OPENAI_API_KEY", !config.paypal.clientId && "PAYPAL_CLIENT_ID", !config.paypal.clientSecret && "PAYPAL_CLIENT_SECRET", !process.env.SESSION_SECRET && "SESSION_SECRET", config.ai.provider !== "openai" && "AI_PROVIDER=openai"].filter(Boolean);
  if (missing.length) {
    console.error(`Refusing to start: ${missing.join(", ")} not set. The deployed app never runs its AI or money steps on stand-ins.`);
    process.exit(1);
  }
}
const db = await getDb();
await syncThresholds(db);
// Private demos made by an earlier build get any new tables (the schema only adds, IF NOT EXISTS).
if (config.workspaces.enabled) {
  let n = 0;
  for (const w of await liveWorkspaces()) {
    try {
      await inWorkspace(w.id, () => db.exec(SCHEMA));
      n++;
    } catch (e) {
      console.error(`[boot] could not bring demo ${w.id} up to date: ${(e as Error).message}`);
    }
  }
  if (n) console.log(`Brought ${n} private demo${n === 1 ? "" : "s"} up to date.`);
}
if (config.demoMode && config.workspaces.enabled && (await showcaseStale())) {
  await rebuildShowcase();
  console.log("Showcase studio built.");
}
const app = createApp();
app.listen(config.port, () => {
  console.log(`Callback on ${config.appUrl} (port ${config.port}) · db ${db.kind} · PayPal ${paypalConfigured() ? config.paypal.env : "not configured"} · brain ${providerLabel()} · phone ${telephonyReady() ? "Twilio" : "simulator"}`);
});
if (config.inlineWorker) startInlineWorker(db, config.workerIntervalMs);
