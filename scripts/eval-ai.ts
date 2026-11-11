/**
 * Runs the AI evaluation on the live model and writes eval/results/ai-eval.json (rendered on /proof).
 * Usage: node --env-file=.env --import tsx scripts/eval-ai.ts [--fresh]
 * --fresh asks the Decisions API again for the held-out scam messages instead of replaying the calibration answers.
 */
import { writeFileSync } from "node:fs";
import { runAiEval } from "../src/eval/regression.js";

const r = await runAiEval({ fresh: process.argv.includes("--fresh") });
// Who ran it is recorded, so /proof says "nightly" only when the scheduled GitHub workflow wrote the file.
const out = { ...r, runner: process.env.GITHUB_ACTIONS === "true" ? `github-actions:${process.env.GITHUB_EVENT_NAME ?? "run"}` : "by hand" };
writeFileSync("eval/results/ai-eval.json", JSON.stringify(out, null, 1) + "\n");
for (const j of r.jobs) {
  console.log(`\n## ${j.job}: ${j.passed}/${j.total} (${j.model ?? "not run"})`);
  for (const c of j.cases) if (j.job.startsWith("Call") || j.job.startsWith("Policy") || !c.pass) console.log(`${c.pass ? "PASS" : "FAIL"} ${c.id}: ${c.why} | ${c.answer.slice(0, 220)}`);
}
process.exit(0);
