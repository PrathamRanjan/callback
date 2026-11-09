import { mkdirSync, writeFileSync } from "node:fs";
import { openDb, setDb } from "../src/db.js";
import { harnessContext, renderAdversarialReport, runAdversarial } from "../src/eval/adversarial.js";
import { seedDemo } from "../src/services/seed.js";

const db = await openDb({ memory: true });
setDb(db);
await seedDemo(db, { now: new Date("2026-03-04T02:00:00Z"), pinClock: true });
const ctx = (await harnessContext(db))!;
const out = await runAdversarial(ctx, db);
const md = await renderAdversarialReport(out);
mkdirSync("eval", { recursive: true });
writeFileSync("eval/adversarial.md", md);
console.log(md);
const missed = out.filter((r) => !r.caught);
if (missed.length) {
  console.error(`\n${missed.length} attack(s) NOT blocked: ${missed.map((m) => m.id).join(", ")}`);
  process.exit(1);
}
process.exit(0);
