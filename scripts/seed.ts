import { getDb } from "../src/db.js";
import { planCalls } from "../src/services/planner.js";
import { resetAndSeed } from "../src/web/demo.js";

const pin = process.argv.includes("--pin");
const seeded = await resetAndSeed({ now: pin ? new Date("2026-03-04T02:00:00Z") : new Date(), pinClock: pin });
const db = await getDb();
const plan = await planCalls(db, seeded.business.id, "seed");
console.log(`Seeded ${seeded.business.name} (${seeded.business.tz})${pin ? ", clock pinned to Wed 13:00 Sydney" : ""}.`);
console.log(`Owner key: ${seeded.ownerKey}`);
console.log(`Staff key: ${seeded.staffKey}`);
console.log(`Planned ${plan.planned} calls, blocked ${plan.blocked}.`);
for (const [k, v] of Object.entries(seeded.customers)) console.log(`  customer ${k}: /c/${v.token}`);
await db.close();
