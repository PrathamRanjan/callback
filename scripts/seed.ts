import { getDb } from "../src/db.js";
import { planCalls } from "../src/services/planner.js";
import { demoClock } from "../src/services/workspaces.js";
import { resetAndSeed } from "../src/web/demo.js";

const pin = process.argv.includes("--pin");
// Spec A4: no fixed dates. --pin holds the clock at 11:00 Sydney on today's weekday (next Monday at a weekend).
const seeded = await resetAndSeed({ now: pin ? demoClock() : new Date(), pinClock: pin });
const db = await getDb();
const plan = await planCalls(db, seeded.business.id, "seed");
console.log(`Seeded ${seeded.business.name} (${seeded.business.tz})${pin ? ", clock held at 11:00 Sydney on a weekday" : ""}.`);
console.log(`Owner key: ${seeded.ownerKey}`);
console.log(`Staff key: ${seeded.staffKey}`);
console.log(`Planned ${plan.planned} calls, blocked ${plan.blocked}.`);
for (const [k, v] of Object.entries(seeded.customers)) console.log(`  customer ${k}: /c/${v.token}`);
await db.close();
