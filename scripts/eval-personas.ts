import { mkdirSync, writeFileSync } from "node:fs";
import { getDb } from "../src/db.js";
import { renderPersonaReport, runPersonaSuite } from "../src/eval/personas.js";

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;
await getDb();
const out = await runPersonaSuite(undefined, limit);
const md = await renderPersonaReport();
mkdirSync("eval", { recursive: true });
writeFileSync("eval/personas.md", md);
console.log(md);
console.log(`\n${out.length} runs. Breaches: ${out.reduce((s, r) => s + r.breaches, 0)}. Written to eval/personas.md`);
process.exit(0);
