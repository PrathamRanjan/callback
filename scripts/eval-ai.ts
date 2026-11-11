/**
 * Runs the AI evaluation on the live model and writes eval/results/ai-eval.json (rendered on /proof).
 * Usage: node --env-file=.env --import tsx scripts/eval-ai.ts
 */
import { writeFileSync } from "node:fs";
import { runAiEval } from "../src/eval/regression.js";

const r = await runAiEval();
writeFileSync("eval/results/ai-eval.json", JSON.stringify(r, null, 1) + "\n");
for (const j of r.jobs) {
  console.log(`\n## ${j.job}: ${j.passed}/${j.total} (${j.model ?? "not run"})`);
  for (const c of j.cases) if (j.job.startsWith("Call") || j.job.startsWith("Policy") || !c.pass) console.log(`${c.pass ? "PASS" : "FAIL"} ${c.id}: ${c.why} | ${c.answer.slice(0, 220)}`);
}
process.exit(0);
