/**
 * One-shot jobs for render.yaml's cron services (spec A12). Each runs once over the base studio and every live
 * private demo, prints what it did, and exits non-zero if any part failed, so a failed run shows on Render.
 *   node dist/cron.js reconcile   read every PayPal record back (PayPal is the truth for what was paid)
 *   node dist/cron.js expire      remove private demos past their idle time
 *   node dist/cron.js plan        re-plan today's calls under the current rules
 */
import { config } from "./config.js";
import { getDb, inWorkspace } from "./db.js";
import { expireWorkspaces, liveWorkspaces } from "./services/workspaces.js";
import { handlers } from "./worker.js";

const job = process.argv[2];
const jobs: Record<string, () => Promise<string>> = {
  reconcile: () => eachStudio((ws) => inWorkspace(ws, () => handlers.read_back({}))),
  plan: () => eachStudio((ws) => inWorkspace(ws, () => handlers.plan_calls({}))),
  expire: async () => `${await expireWorkspaces()} private demo(s) removed`,
};

async function eachStudio(run: (ws: string | null) => Promise<unknown>): Promise<string> {
  const spaces: (string | null)[] = [null, ...(config.workspaces.enabled ? (await liveWorkspaces()).map((w) => w.id) : [])];
  const failed: string[] = [];
  for (const ws of spaces) {
    try {
      await run(ws);
    } catch (e) {
      failed.push(`${ws ?? "base"}: ${(e as Error).message}`);
    }
  }
  if (failed.length) throw new Error(`${failed.length} of ${spaces.length} failed: ${failed.join("; ")}`);
  return `${spaces.length} studio(s) done`;
}

if (!jobs[job]) {
  console.error(`Usage: node dist/cron.js ${Object.keys(jobs).join("|")}`);
  process.exit(2);
}
await getDb();
try {
  console.log(`[cron ${job}] ${await jobs[job]()}`);
  process.exit(0);
} catch (e) {
  console.error(`[cron ${job}] failed: ${(e as Error).message}`);
  process.exit(1);
}
