import { afterEach, beforeEach, expect, it } from "vitest";
import { openDb, setDb, type Db } from "../src/db.js";
import { seedDemo } from "../src/services/seed.js";
import { fmtLocal } from "../src/core/time.js";
import { owedToCustomer, type Obligation } from "../src/store.js";

// QC P0-2: the cancelled class's title and appointment must name the same day, and a paid class reads as owed to the customer.
let db: Db;
beforeEach(async () => { db = await openDb({ memory: true }); setDb(db); });
afterEach(async () => { await db.close(); });

it("Tom's cancelled class: one day in title and appointment; $35 owed to him, not an open balance", async () => {
  await seedDemo(db, { now: new Date("2026-03-04T02:00:00Z"), pinClock: true });
  const o = (await db.query<Obligation>("SELECT * FROM obligations WHERE kind = 'class_cancel'")).rows[0];
  const day = fmtLocal(o.appointment_at!, "Australia/Sydney").replace(",", "").split(" ")[0];
  expect(o.title.slice(0, 3)).toBe(day.slice(0, 3));
  expect(owedToCustomer(o)).toBe(3500);
  expect(owedToCustomer({ ...o, status: "refunded" })).toBe(0);
});
