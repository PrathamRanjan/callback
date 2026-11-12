import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { getDb, inWorkspace } from "../src/db.js";
import { setPayPal } from "../src/paypal/index.js";
import { expireWorkspaces, getWorkspace } from "../src/services/workspaces.js";
import { unsign } from "../src/lib/crypto.js";
import { Client } from "./client.js";
import { serveTracked } from "./journey-coverage.js";
import { freshWorld } from "./setup.js";

// Private demo workspaces (spec A1) and the saved demo wallet (A2.1): two visitors never see each other's data,
// money paid from the wallet is read back, webhooks land in the right workspace, idle workspaces disappear.
let world: Awaited<ReturnType<typeof freshWorld>>;
let srv: Awaited<ReturnType<typeof serveTracked>>;
const saved = { ...config.workspaces, vault: config.paypal.demoVaultToken };

beforeAll(async () => {
  world = await freshWorld();
  (config.workspaces as any).enabled = true;
  (config.workspaces as any).startsPerHour = 3;
  (config.paypal as any).demoVaultToken = "FAKE-VAULT-TOKEN";
  srv = await serveTracked(createApp());
});
afterAll(async () => {
  Object.assign(config.workspaces, { enabled: false, startsPerHour: saved.startsPerHour });
  (config.paypal as any).demoVaultToken = saved.vault;
  await srv.close();
  setPayPal(null);
  await world.db.close();
});

const loc = (r: { location: string | null }) => decodeURIComponent(r.location ?? "");
const wsOf = (c: Client) => unsign(decodeURIComponent(c.cookies.get("cb_ws") ?? ""));
async function waitFor(fn: () => Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
const inWs = <T>(ws: string, fn: () => Promise<T>) => inWorkspace(ws, fn);

describe("private demo workspaces", () => {
  const a = () => new Client(srv.base);
  let A: Client;
  let B: Client;
  let wsA = "";
  let wsB = "";

  it("each visitor gets their own populated studio, signed in as the owner", async () => {
    A = a();
    B = a();
    expect((await A.post("/demo/start")).location).toBe("/today");
    expect((await B.post("/demo/signin-as", { role: "owner" })).location).toBe("/today");
    wsA = wsOf(A)!;
    wsB = wsOf(B)!;
    expect(wsA).toMatch(/^[a-z0-9]{10}$/);
    expect(wsB).not.toBe(wsA);
    const ca = (await A.get("/api/app/customers")).json;
    const cb = (await B.get("/api/app/customers")).json;
    expect(ca.length).toBe(11); // the eight planned-call customers plus three from earlier sample calls
    expect(new Set(ca.map((c: any) => c.id)).size).toBe(11);
    expect(ca.map((c: any) => c.id).some((id: string) => cb.some((x: any) => x.id === id))).toBe(false);
    // One move held for the owner, made by the real gate ($360 is over the $300 limit).
    expect((await A.get("/api/app/guard")).json.pending.length).toBe(1);
    // The studio clock is a current weekday morning, never a fixed date.
    const s = (await A.get("/api/app/session")).json;
    expect(s.workspace.private).toBe(true);
    expect(Math.abs(new Date(s.business.clock).getTime() - Date.now())).toBeLessThan(4 * 86400_000);
  });

  it("the seed's three payments are made from the saved wallet and read back", async () => {
    expect(await waitFor(async () => /3 of 3 payments confirmed/.test((await getWorkspace(wsA, true))?.seed_note ?? ""))).toBe(true);
    const rows = await inWs(wsA, async () => (await (await getDb()).query<any>("SELECT via, status FROM pay_links WHERE via = 'demo_wallet'")).rows);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r: any) => r.status === "paid")).toBe(true);
    expect(world.fake.calls.filter((c) => c === "createVaultOrder").length).toBeGreaterThanOrEqual(3);
  });

  it("an action in one workspace never shows in the other", async () => {
    const before = (await B.get("/api/app/session")).json.business.clock;
    expect((await A.post("/demo/clock", { days: "1" })).location).toMatch(/ok=/);
    expect((await A.post("/demo/fault", { method: "createOrder", kind: "fail_503" })).location).toMatch(/ok=/);
    const apr = (await A.get("/api/app/guard")).json.pending[0];
    expect((await A.post(`/ops/guard/approvals/${apr.id}/decline`)).location).toMatch(/ok=/);
    expect((await B.get("/api/app/session")).json.business.clock).toBe(before);
    expect((await B.get("/api/app/guard")).json.pending.length).toBe(1);
    const faults = await inWs(wsB, async () => (await (await getDb()).query("SELECT 1 FROM demo_faults")).rows.length);
    expect(faults).toBe(0);
    expect((await A.get("/api/app/guard")).json.pending.length).toBe(0);
  });

  it("the customer page pays from the saved wallet with no login, in that workspace only", async () => {
    const cust = (await B.get("/api/app/customers")).json.find((c: any) => c.name.startsWith("Priya"));
    const detail = (await B.get(`/api/app/customers/${cust.id}`)).json;
    const link: string = detail.customer.link;
    expect(link).toContain(`_w${wsB}_`);
    const deposit = detail.items.find((i: any) => i.kind === "deposit");
    const phone = a(); // no cookie: the customer's own phone
    const page = (await phone.get(`/api/app${link}`)).json;
    expect(page.demo_wallet).toBe(true);
    const r = await phone.post(`${link}/wallet/${deposit.id}`);
    expect(r.location).toMatch(/ok=Paid.*capture/);
    expect((await B.get(`/api/app/customers/${cust.id}`)).json.items.find((i: any) => i.id === deposit.id).status).toBe("paid");
    const priyaA = (await A.get("/api/app/customers")).json.find((c: any) => c.name.startsWith("Priya"));
    expect((await A.get(`/api/app/customers/${priyaA.id}`)).json.items.find((i: any) => i.kind === "deposit").status).not.toBe("paid");
    // With the wallet switched off, the page offers only PayPal's own page and nothing shows a made-up id.
    (config.paypal as any).demoVaultToken = "";
    expect((await phone.get(`/api/app${link}`)).json.demo_wallet).toBe(false);
    const lena = (await B.get("/api/app/customers")).json.find((c: any) => c.name.startsWith("Lena"));
    const lenaD = (await B.get(`/api/app/customers/${lena.id}`)).json;
    expect(loc(await phone.post(`${lenaD.customer.link}/wallet/${lenaD.items[0].id}`))).toMatch(/err=.*not set up/);
    (config.paypal as any).demoVaultToken = "FAKE-VAULT-TOKEN";
  });

  it("a PayPal webhook lands in the workspace its custom_id names", async () => {
    const r = await a().postJson("/webhooks/paypal", { id: "WH-TEST-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAPX", custom_id: `${wsA}:obl_x` } });
    expect(r.json.workspace).toBe("private demo");
    const inA = await inWs(wsA, async () => (await (await getDb()).query("SELECT 1 FROM webhook_events WHERE id = 'WH-TEST-1'")).rows.length);
    const inB = await inWs(wsB, async () => (await (await getDb()).query("SELECT 1 FROM webhook_events WHERE id = 'WH-TEST-1'")).rows.length);
    expect([inA, inB]).toEqual([1, 0]);
  });

  it("the judge page (spec A3.1): steps open this visitor's own screens and tick themselves when the server records them", async () => {
    const anon = (await a().get("/api/public/judge")).json;
    expect(anon.workspace).toBeNull();
    expect(anon.paths.length).toBe(3);
    expect(anon.paths[0].steps.every((s: any) => s.href === null)).toBe(true); // no demo yet: the first tap builds one
    expect(anon.live.find((r: any) => r.piece.startsWith("Phone calls")).live).toBe(false);
    // An earlier test moved A's clock a day on; from a Friday that is a Saturday, which isn't a calling day. Move on to
    // Monday first, so the call this test places can start and the blocked call it opens is blocked by a rule, whatever
    // weekday the suite runs on.
    const clock = new Date((await A.get("/api/app/session")).json.business.clock);
    const dow = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", weekday: "short" }).format(clock);
    if (dow === "Sat" || dow === "Sun") await A.post("/demo/clock", { days: dow === "Sat" ? "2" : "1" });
    const before = (await A.get("/api/public/judge")).json;
    expect(before.workspace.qr_svg).toMatch(/^<svg/);
    expect(before.workspace.join_url).toContain("/demo/join/");
    const [take, refuse, approve] = before.paths;
    expect(take.steps[0].href).toMatch(/^\/calls\/call_/);
    expect(take.steps[1].href).toContain("?say=");
    expect(take.steps[3].href).toContain(`_w${wsA}_`);
    expect(refuse.steps[2].href).toContain("/safety?text=");
    expect(before.checklist.call_placed).toBeUndefined();
    // A declined the seed's held charge in an earlier test, after opening Approvals: those two ticked then, and the
    // seed's own hold and sample calls ticked nothing.
    expect(Object.keys(before.checklist).sort()).toEqual(["approval_decided", "viewed_hold"]);
    // B paid Priya's deposit from the saved wallet in the test above: ticked in B's copy only.
    expect((await B.get("/api/public/judge")).json.checklist.paid_from_wallet).toBeTruthy();
    expect(before.checklist.paid_from_wallet).toBeUndefined();
    await A.post(`${take.steps[0].href}/place`, { mode: "simulator" });
    const blocked = refuse.steps[1].href as string;
    expect(blocked).toMatch(/^\/calls\//);
    await A.get(`/api/app${blocked}`);
    const after = (await A.get("/api/public/judge")).json.checklist;
    expect(Object.keys(after).sort()).toEqual(["approval_decided", "call_placed", "opened_blocked_call", "viewed_hold"]);
    expect(after.viewed_hold).toBe(before.checklist.viewed_hold); // ticked once, with the time it first happened
    expect(after.ai_turn).toBeUndefined(); // the test brain is rules, not a model: no "AI turn" tick
    expect(approve.steps.map((s: any) => s.key)).toEqual(["viewed_hold", "approval_decided", "opened_money"]);
  });

  it("the join link opens the same workspace on a second device; reset rebuilds only it", async () => {
    const join = (await A.get("/api/app/session")).json.workspace.join_url as string;
    const phone = a();
    expect((await phone.get(new URL(join).pathname)).location).toBe("/today");
    expect(wsOf(phone)).toBe(wsA);
    expect((await a().get("/demo/join/not-a-token")).location).toMatch(/\/try\?err=/);
    const bClock = (await B.get("/api/app/session")).json.business.clock;
    expect(loc(await A.post("/demo/reset"))).toMatch(/ok=Your demo was rebuilt/);
    expect(wsOf(A)).toBe(wsA);
    expect((await A.get("/api/app/guard")).json.pending.length).toBe(1);
    expect((await B.get("/api/app/session")).json.business.clock).toBe(bClock);
  });

  it("strangers cannot arm faults or move the clock; starts are rate limited", async () => {
    const anon = a();
    expect(loc(await anon.post("/demo/fault", { method: "createOrder", kind: "fail_503" }))).toMatch(/err=Only the owner/);
    expect(loc(await anon.post("/demo/clock", { days: "1" }))).toMatch(/err=Only the owner/);
    expect(loc(await a().post("/demo/start"))).toBe("/today"); // the third start this hour is allowed
    expect(loc(await anon.post("/demo/start"))).toMatch(/err=This address has started 3/);
  });

  it("an idle workspace is removed with everything in it", async () => {
    const db = await getDb();
    await inWorkspace(null, () => db.query("UPDATE workspaces SET expires_at = now() - interval '1 minute' WHERE id = $1", [wsB]));
    expect(await expireWorkspaces()).toBe(1);
    expect(await getWorkspace(wsB, true)).toBeNull();
    const schema = await inWorkspace(null, () => db.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [`cbws_${wsB}`]));
    expect(schema.rows.length).toBe(0);
    expect((await B.get("/api/app/session")).json.me).toBeNull();
  });
});
