/**
 * The background worker as its own process (render.yaml's callback-worker), for when the web service runs with
 * CB_INLINE_WORKER=false. Same jobs and cadence as the inline worker: plan calls, read PayPal back, send channel
 * messages and pushes, end stuck calls, expire idle demos. Live voice calls stay on the web service, which holds
 * their sockets.
 */
import { config } from "./config.js";
import { getDb } from "./db.js";
import { tick } from "./worker.js";

const db = await getDb();
console.log(`Callback worker · db ${db.kind} · every ${config.workerIntervalMs} ms`);
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
while (!stopping) {
  try {
    await tick(db);
  } catch (e) {
    console.error("[worker]", (e as Error).message);
  }
  await new Promise((r) => setTimeout(r, config.workerIntervalMs));
}
process.exit(0);
