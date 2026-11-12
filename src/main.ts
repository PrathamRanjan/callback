import { createApp } from "./app.js";
import { config } from "./config.js";
import { getDb, inWorkspace, SCHEMA } from "./db.js";
import { paypalConfigured } from "./paypal/index.js";
import { providerLabel } from "./ai/provider.js";
import { syncThresholds } from "./ai/decisions.js";
import { telephonyReady } from "./voice/telephony.js";
import { attachVoiceBridge } from "./voice/bridge.js";
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
// The database can be briefly away at start (a restart, "in recovery mode"): wait for it rather than exiting,
// so a deploy doesn't fail on a passing database blip. Gives up after about three minutes.
async function dbWhenReady() {
  for (let attempt = 1; ; attempt++) {
    try {
      return await getDb();
    } catch (e) {
      const msg = (e as Error).message;
      if (attempt >= 18 || !/recovery mode|starting up|ECONNRESET|ECONNREFUSED|terminated|timeout|57P03|shutting down/i.test(msg + ((e as any).code ?? ""))) throw e;
      console.error(`[boot] database not ready (${msg.slice(0, 120)}), trying again in 10 s (${attempt}/18)`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}
const db = await dbWhenReady();
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
const server = app.listen(config.port, () => {
  console.log(`Callback on ${config.appUrl} (port ${config.port}) · db ${db.kind} · PayPal ${paypalConfigured() ? config.paypal.env : "not configured"} · brain ${providerLabel()} · phone ${telephonyReady() ? "Twilio" : "simulator"}`);
});
attachVoiceBridge(server);
if (config.inlineWorker) startInlineWorker(db, config.workerIntervalMs);
