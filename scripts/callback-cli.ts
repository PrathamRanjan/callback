/** Tiny CLI: plan, list, place a call in the simulator, say lines, show a trace. */
import { getDb } from "../src/db.js";
import { customerSays, startCall } from "../src/services/calls.js";
import { candidates, planCalls } from "../src/services/planner.js";
import { callsOf, firstBiz, callById } from "../src/store.js";
import { loadRun } from "../src/trace.js";

const [cmd, ...args] = process.argv.slice(2);
const db = await getDb();
const biz = await firstBiz(db);
if (!biz) {
  console.log("Seed first: npm run seed");
  process.exit(1);
}
switch (cmd) {
  case "plan": {
    const out = await planCalls(db, biz.id, "cli");
    console.log(out);
    for (const c of await candidates(db, biz.id)) console.log(`${c.verdict.ok ? "CALL " : "SKIP "} ${c.customer.name.padEnd(26)} ${c.purpose.padEnd(16)} ${c.reason}${c.verdict.ok ? "" : ` | ${c.verdict.reasons.join("; ")}`}`);
    break;
  }
  case "calls": {
    for (const c of await callsOf(db, biz.id)) console.log(`${c.id} ${c.status.padEnd(12)} ${c.purpose.padEnd(16)} ${c.outcome ?? ""} ${c.reason}`);
    break;
  }
  case "start": {
    const r = await startCall(db, args[0], "simulator", "cli");
    console.log(`agent: ${r.opening}`);
    break;
  }
  case "say": {
    const r = await customerSays(db, args[0], args.slice(1).join(" "), "cli");
    console.log(`agent: ${r.say}${r.tool_result ? `\n[${r.tool}: ${r.tool_result}]` : ""}${r.ended ? `\n[ended: ${r.outcome}]` : ""}`);
    break;
  }
  case "trace": {
    const c = await callById(db, args[0]);
    const t = c.run_id ? await loadRun(c.run_id) : null;
    for (const s of t?.steps ?? []) console.log(`${String(s.step).padStart(3)} ${s.actor.padEnd(9)} ${s.tool.padEnd(28)} ${s.gate ?? ""} ${s.policy ?? ""}`);
    break;
  }
  default:
    console.log("usage: npm run cli -- plan | calls | start <call> | say <call> <text…> | trace <call>");
}
await db.close();
