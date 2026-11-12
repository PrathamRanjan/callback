import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { config } from "./config.js";

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  exec(sql: string): Promise<void>;
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  kind: "pglite" | "postgres";
}

/**
 * Private demo workspaces (spec A1). Each visitor's copy of the studio lives in its own Postgres schema, and the
 * workspace a piece of work belongs to travels with it in AsyncLocalStorage: every query made inside
 * `inWorkspace(id, fn)` runs with `search_path` set to that schema, so the existing queries need no change and one
 * visitor's rows, approvals, clock, faults and kill switches can never reach another's. Outside a workspace, queries
 * run in the app's own schema: the shared showcase studio plus the registry tables (workspaces, ws_refs).
 */
const wsContext = new AsyncLocalStorage<{ ws: string | null }>();
export const currentWs = (): string | null => wsContext.getStore()?.ws ?? null;
export function inWorkspace<T>(ws: string | null, fn: () => T): T {
  return wsContext.run({ ws }, fn);
}
export const WS_ID = /^[a-z0-9]{10}$/;
export function wsSchemaName(ws: string): string {
  if (!WS_ID.test(ws)) throw new Error(`Bad workspace id: ${ws}`);
  return `cbws_${ws}`;
}
/** A secret that names the workspace it belongs to (customer link token, access key): `cbt_w<ws>_<random>`. */
export function scopedSecret(prefix: string): string {
  const ws = currentWs();
  return `${prefix}_${ws ? `w${ws}_` : ""}${randomBytes(24).toString("base64url")}`;
}
/** The search_path the connection starts with (Render: the app's own schema via ?options=-c search_path=callback). */
let basePath = "public";
const wantedPath = () => {
  const ws = currentWs();
  return ws ? `"${wsSchemaName(ws)}"` : basePath;
};

async function openPglite(path: string | null): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (path) mkdirSync(path, { recursive: true });
  const pg = path ? new PGlite(path) : new PGlite();
  await pg.waitReady;
  let pathNow = String((await pg.query<{ search_path: string }>("SHOW search_path")).rows[0]?.search_path ?? "public");
  basePath = pathNow;
  // One connection: every statement goes through one queue, and the search_path is switched inside the queue, so a
  // query can never run under another workspace's path.
  let chain: Promise<unknown> = Promise.resolve();
  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    const want = wantedPath();
    const p = chain.then(async () => {
      if (pathNow !== want) {
        await pg.exec(`SET search_path TO ${want}`);
        pathNow = want;
      }
      return fn();
    });
    chain = p.catch(() => undefined);
    return p;
  };
  return {
    kind: "pglite",
    query: (sql, params) => run(async () => ({ rows: (await pg.query(sql, params as any[])).rows as any[] })),
    exec: (sql) => run(async () => {
      await pg.exec(sql);
    }),
    tx: (fn) => run(() => pg.transaction(async (t) => fn({ query: async (s, p) => ({ rows: (await t.query(s, p as any[])).rows as any[] }) }))) as any,
    close: async () => {
      await chain;
      await pg.close();
    },
  };
}

async function openPostgres(url: string): Promise<Db> {
  const pgmod = await import("pg");
  const Pool = (pgmod as any).default?.Pool ?? (pgmod as any).Pool;
  const pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }, max: 10 });
  {
    const c = await pool.connect();
    try {
      basePath = String((await c.query("SHOW search_path")).rows[0]?.search_path ?? "public");
    } finally {
      c.release();
    }
  }
  // Each pooled connection remembers the path it was last set to; a query switches it only when it differs.
  const onClient = async <T>(fn: (c: any) => Promise<T>): Promise<T> => {
    const want = wantedPath();
    const c = await pool.connect();
    try {
      if (c.__cbPath !== want) {
        await c.query(`SET search_path TO ${want}`);
        c.__cbPath = want;
      }
      return await fn(c);
    } finally {
      c.release();
    }
  };
  return {
    kind: "postgres",
    query: (sql, params) => onClient(async (c) => ({ rows: (await c.query(sql, params)).rows })),
    exec: (sql) => onClient(async (c) => {
      await c.query(sql);
    }),
    tx: (fn) => onClient(async (client) => {
      try {
        await client.query("BEGIN");
        const out = await fn({ query: async (s: string, p?: unknown[]) => ({ rows: (await client.query(s, p)).rows }) });
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }),
    close: async () => {
      await pool.end();
    },
  };
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, tz TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD',
  phone TEXT NOT NULL DEFAULT '', sim_now TEXT, settings JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','staff')), key_hash TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL DEFAULT '',
  tz TEXT NOT NULL, token TEXT NOT NULL UNIQUE, consent JSONB, dnc BOOLEAN NOT NULL DEFAULT false, notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Money the business is owed or must settle: a deposit for tomorrow's appointment, an overdue invoice, a cancelled class.
CREATE TABLE IF NOT EXISTS obligations (
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), customer_id TEXT NOT NULL REFERENCES customers(id),
  kind TEXT NOT NULL CHECK (kind IN ('deposit','invoice','class_cancel')), title TEXT NOT NULL, amount_cents INTEGER NOT NULL,
  due_at TEXT, appointment_at TEXT, status TEXT NOT NULL CHECK (status IN ('open','link_sent','invoiced','planned','paid','credited','refunded','void')),
  paypal_order_id TEXT, capture_id TEXT, paypal_invoice_id TEXT, subscription_id TEXT, discount_cents INTEGER NOT NULL DEFAULT 0,
  settled_cents INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), customer_id TEXT NOT NULL REFERENCES customers(id), obligation_id TEXT REFERENCES obligations(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('confirm_deposit','chase_invoice','cancel_class')),
  status TEXT NOT NULL CHECK (status IN ('planned','blocked','ringing','in_progress','ended','skipped')),
  mode TEXT NOT NULL DEFAULT 'simulator' CHECK (mode IN ('simulator','phone','realtime','eval')),
  reason TEXT NOT NULL DEFAULT '', outcome TEXT, persona TEXT, scheduled_at TEXT, started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ,
  transcript JSONB NOT NULL DEFAULT '[]', state JSONB NOT NULL DEFAULT '{}', run_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  collected_cents INTEGER NOT NULL DEFAULT 0, discount_cents INTEGER NOT NULL DEFAULT 0, breaches INTEGER NOT NULL DEFAULT 0,
  consent_ok BOOLEAN, hours_ok BOOLEAN, provider_call_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calls_biz ON calls(business_id, created_at DESC);
-- One open call per obligation: the worker and a demo reset planning at the same moment must not create two.
DELETE FROM calls a USING calls b WHERE a.obligation_id = b.obligation_id AND a.id <> b.id AND a.status IN ('planned','blocked') AND b.status IN ('planned','blocked','ringing','in_progress') AND a.created_at > b.created_at;
CREATE UNIQUE INDEX IF NOT EXISTS calls_one_open_per_obligation ON calls(obligation_id) WHERE status IN ('planned','blocked','ringing','in_progress');
CREATE TABLE IF NOT EXISTS callbacks (
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL, call_id TEXT NOT NULL REFERENCES calls(id), customer_id TEXT NOT NULL, at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pay_links (
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL, obligation_id TEXT NOT NULL REFERENCES obligations(id), call_id TEXT, paypal_order_id TEXT, approve_url TEXT,
  amount_cents INTEGER NOT NULL, status TEXT NOT NULL, request_id TEXT UNIQUE NOT NULL, run_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Holds (spec B2 item 3): an AUTHORIZE order for a deposit, captured when the customer attends or voided on a timely cancel.
CREATE TABLE IF NOT EXISTS holds (
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL, obligation_id TEXT NOT NULL REFERENCES obligations(id), call_id TEXT, amount_cents INTEGER NOT NULL,
  paypal_order_id TEXT, authorization_id TEXT, capture_id TEXT, approve_url TEXT, via TEXT NOT NULL DEFAULT 'link',
  status TEXT NOT NULL CHECK (status IN ('creating','link_sent','authorized','captured','voided','expired','failed','unknown')),
  request_id TEXT UNIQUE NOT NULL, run_id TEXT, expires_at TEXT, decided_at TIMESTAMPTZ, decided_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL, obligation_id TEXT NOT NULL REFERENCES obligations(id), call_id TEXT, paypal_invoice_id TEXT, amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL, href TEXT, request_id TEXT UNIQUE NOT NULL, run_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS instalment_plans (
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL, obligation_id TEXT NOT NULL REFERENCES obligations(id), call_id TEXT, option JSONB NOT NULL,
  paypal_plan_id TEXT, subscription_id TEXT, approve_url TEXT, status TEXT NOT NULL, request_id TEXT UNIQUE NOT NULL, run_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL, obligation_id TEXT NOT NULL REFERENCES obligations(id), call_id TEXT, paypal_refund_id TEXT, amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL, request_id TEXT UNIQUE NOT NULL, run_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL, text TEXT NOT NULL, rules JSONB NOT NULL, unexpressed JSONB NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'rules',
  status TEXT NOT NULL CHECK (status IN ('draft','active','retired')), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Seeded 90-day history of calls a person made by hand, for the policy backtest.
CREATE TABLE IF NOT EXISTS call_history (
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL, at TIMESTAMPTZ NOT NULL, purpose TEXT NOT NULL, customer TEXT NOT NULL, amount_cents INTEGER NOT NULL,
  outcome TEXT NOT NULL, discount_pct INTEGER NOT NULL DEFAULT 0, instalments INTEGER NOT NULL DEFAULT 1, local_hour INTEGER NOT NULL, consent BOOLEAN NOT NULL DEFAULT true,
  owner_would_approve BOOLEAN NOT NULL DEFAULT true, by_hand_minutes INTEGER NOT NULL DEFAULT 8, is_sample BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS voice_events (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, call_id TEXT, kind TEXT NOT NULL, payload JSONB NOT NULL, verified BOOLEAN NOT NULL DEFAULT false, at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY, business_id TEXT NOT NULL, customer_id TEXT, call_id TEXT, type TEXT NOT NULL, summary TEXT NOT NULL, actor TEXT NOT NULL DEFAULT 'system',
  data JSONB, at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS demo_faults (id BIGSERIAL PRIMARY KEY, method TEXT NOT NULL, kind TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY, event_type TEXT NOT NULL, resource_id TEXT, body JSONB NOT NULL, verified BOOLEAN NOT NULL, processed_at TIMESTAMPTZ, received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS jobs_queue (
  id BIGSERIAL PRIMARY KEY, type TEXT NOT NULL, dedupe_key TEXT UNIQUE, payload JSONB NOT NULL DEFAULT '{}', run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')), attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_queue_due ON jobs_queue(status, run_at);
-- Foundation (roadmap Part B): model audit, traces, guard, channels, evals, judge mode.
CREATE TABLE IF NOT EXISTS ai_calls (
  id BIGSERIAL PRIMARY KEY, purpose TEXT NOT NULL, model TEXT NOT NULL, via TEXT NOT NULL, input_hash TEXT NOT NULL, output_hash TEXT NOT NULL DEFAULT '',
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0,
  ok BOOLEAN NOT NULL, error TEXT, output JSONB, run_id TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_calls_hash ON ai_calls(input_hash, id DESC);
-- Spec A5.2: thresholds for Decisions answers live in code and data (thresholds.json, written by scripts/calibrate.ts).
CREATE TABLE IF NOT EXISTS decision_thresholds (
  name TEXT PRIMARY KEY, clear_below DOUBLE PRECISION NOT NULL, hold_above DOUBLE PRECISION NOT NULL, calibrated_on TEXT, n INTEGER NOT NULL DEFAULT 0,
  precision_at_hold DOUBLE PRECISION, recall_at_hold DOUBLE PRECISION, set_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, agent_id TEXT, subject TEXT NOT NULL DEFAULT '', entity TEXT, entity_id TEXT,
  status TEXT NOT NULL DEFAULT 'running', started_at TIMESTAMPTZ NOT NULL DEFAULT now(), ended_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS agent_trace (
  id BIGSERIAL PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id), step INTEGER NOT NULL, actor TEXT NOT NULL, tool TEXT NOT NULL,
  args JSONB, policy TEXT, gate TEXT, result JSONB, pp_request_id TEXT, pp_debug_id TEXT, duration_ms INTEGER, at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_trace_run ON agent_trace(run_id, step);
-- Spec A5.3: what the Ask agent proposes; the owner decides with the normal buttons. A proposal never moves money.
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL, kind TEXT NOT NULL, payload JSONB NOT NULL DEFAULT '{}', reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')), run_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_chain (
  seq BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL, payload JSONB NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kill_switches (scope TEXT PRIMARY KEY, engaged BOOLEAN NOT NULL DEFAULT false, reason TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, action TEXT NOT NULL, payload_hash TEXT NOT NULL, payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','expired')), method TEXT, decided_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, credential_id TEXT NOT NULL, public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS provenance (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, trust TEXT NOT NULL CHECK (trust IN ('system','paypal','owner','agent','document','message','speech','web')), text TEXT NOT NULL,
  entity TEXT, entity_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS channel_messages (
  id TEXT PRIMARY KEY, channel TEXT NOT NULL, direction TEXT NOT NULL CHECK (direction IN ('in','out')), address TEXT NOT NULL, body TEXT NOT NULL, buttons JSONB,
  entity TEXT, entity_id TEXT, external_id TEXT, status TEXT NOT NULL DEFAULT 'queued', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS party_links (id TEXT PRIMARY KEY, channel TEXT NOT NULL, address TEXT NOT NULL, party TEXT NOT NULL, party_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (channel, address));
CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY, party TEXT NOT NULL, party_id TEXT NOT NULL, subscription JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS judge_sessions (id TEXT PRIMARY KEY, beat INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY, suite TEXT NOT NULL, arm TEXT NOT NULL, case_id TEXT NOT NULL, expected TEXT NOT NULL, actual TEXT NOT NULL, correct BOOLEAN NOT NULL,
  trap BOOLEAN NOT NULL DEFAULT false, naive_paid_cents INTEGER NOT NULL DEFAULT 0, ours_paid_cents INTEGER NOT NULL DEFAULT 0, cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0, detail JSONB, at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eval_runs_suite ON eval_runs(suite, arm);
CREATE TABLE IF NOT EXISTS guard_settings (
  id TEXT PRIMARY KEY, auto_charge_max_cents INTEGER NOT NULL DEFAULT 30000, auto_refund_max_cents INTEGER NOT NULL DEFAULT 10000,
  auto_discount_max_pct INTEGER NOT NULL DEFAULT 10, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Why an item exists in the owner's words (a class cancelled because the instructor is ill). The agent may say it; it never invents one.
ALTER TABLE obligations ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '';
-- A cancelled class that came from a booking paid by PayPal points back at it, so the refund goes to that capture.
ALTER TABLE obligations ADD COLUMN IF NOT EXISTS source_id TEXT;
-- Sample rows (spec 0.2 rule 4): seeded calls that never happened carry the flag and a visible "Sample" chip.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS is_sample BOOLEAN NOT NULL DEFAULT false;
-- How a payment was made: a link the customer approves on PayPal, or the demo's saved sandbox wallet.
ALTER TABLE pay_links ADD COLUMN IF NOT EXISTS via TEXT NOT NULL DEFAULT 'link';
-- Languages (spec B): the page language a person picked, the language a customer is called and texted in, the language
-- a call was actually spoken in (detected from the first words), and machine translations of its transcript by language.
ALTER TABLE people ADD COLUMN IF NOT EXISTS lang TEXT NOT NULL DEFAULT 'en';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS lang TEXT NOT NULL DEFAULT 'en';
ALTER TABLE calls ADD COLUMN IF NOT EXISTS lang TEXT;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS translations JSONB NOT NULL DEFAULT '{}';
-- Every MCP request an outside assistant makes, for the /agents watch panel (spec C). Arguments cut to 300 chars.
CREATE TABLE IF NOT EXISTS mcp_calls (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  server TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  method TEXT NOT NULL,
  tool TEXT,
  args TEXT,
  status INTEGER,
  ms INTEGER,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcp_calls_biz_at ON mcp_calls (business_id, at DESC);
CREATE INDEX IF NOT EXISTS obligations_biz ON obligations(business_id, created_at);
CREATE INDEX IF NOT EXISTS customers_biz ON customers(business_id, name);
CREATE INDEX IF NOT EXISTS events_biz ON events(business_id, at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_started ON agent_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS channel_messages_at ON channel_messages(created_at DESC);
`;

/** Every table of a studio, children first: what a showcase rebuild or a full reset empties. */
export const APP_TABLES = ["holds", "proposals", "voice_events", "callbacks", "pay_links", "invoices", "instalment_plans", "refunds", "calls", "obligations", "policies", "call_history", "customers", "people", "events", "demo_faults", "webhook_events", "jobs_queue", "ai_calls", "agent_trace", "agent_runs", "audit_chain", "kill_switches", "approvals", "passkeys", "provenance", "channel_messages", "party_links", "push_subscriptions", "judge_sessions", "eval_runs", "guard_settings", "businesses"];

/** Registry tables: only in the app's own schema, never inside a workspace schema. */
export const REGISTRY = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'visitor' CHECK (kind IN ('visitor','showcase')), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL, ip_hash TEXT NOT NULL DEFAULT '', seed_version INTEGER NOT NULL DEFAULT 1,
  seed_state TEXT NOT NULL DEFAULT 'seeding' CHECK (seed_state IN ('seeding','ready','failed')), seed_note TEXT NOT NULL DEFAULT '',
  checklist JSONB NOT NULL DEFAULT '{}', join_token TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS workspaces_seen ON workspaces(last_seen_at);
-- Which workspace an outside id belongs to (a PayPal order or capture, a phone call), for webhooks that carry no custom_id.
CREATE TABLE IF NOT EXISTS ws_refs (ref TEXT PRIMARY KEY, ws_id TEXT NOT NULL, kind TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS ws_refs_ws ON ws_refs(ws_id);
CREATE TABLE IF NOT EXISTS ws_starts (ip_hash TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now());
-- Live voice starts (spec B2: one call per number an hour, five per address a day), keyed by salted hashes only.
CREATE TABLE IF NOT EXISTS live_starts (key TEXT NOT NULL, kind TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS live_starts_key ON live_starts(key, at);
`;

let shared: Db | null = null;

export async function openDb(opts: { memory?: boolean } = {}): Promise<Db> {
  const db = opts.memory ? await openPglite(null) : config.databaseUrl ? await openPostgres(config.databaseUrl) : await openPglite(config.pglitePath);
  await inWorkspace(null, async () => {
    await db.exec(SCHEMA);
    await db.exec(REGISTRY);
  });
  return db;
}

export async function getDb(): Promise<Db> {
  if (!shared) shared = await openDb();
  return shared;
}

export function setDb(db: Db) {
  shared = db;
}

/** Creates (or recreates) a workspace's schema with the app's tables. */
export async function createWorkspaceSchema(db: Db, ws: string) {
  const name = wsSchemaName(ws);
  await inWorkspace(null, () => db.exec(`DROP SCHEMA IF EXISTS "${name}" CASCADE; CREATE SCHEMA "${name}"`));
  await inWorkspace(ws, () => db.exec(SCHEMA));
}

export async function dropWorkspaceSchema(db: Db, ws: string) {
  await inWorkspace(null, () => db.exec(`DROP SCHEMA IF EXISTS "${wsSchemaName(ws)}" CASCADE`));
}
