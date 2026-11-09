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

async function openPglite(path: string | null): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (path) mkdirSync(path, { recursive: true });
  const pg = path ? new PGlite(path) : new PGlite();
  await pg.waitReady;
  let chain: Promise<unknown> = Promise.resolve();
  return {
    kind: "pglite",
    query: async (sql, params) => ({ rows: (await pg.query(sql, params as any[])).rows as any[] }),
    exec: async (sql) => {
      await pg.exec(sql);
    },
    tx: (fn) => {
      const run = chain.then(() => pg.transaction(async (t) => fn({ query: async (s, p) => ({ rows: (await t.query(s, p as any[])).rows as any[] }) })));
      chain = run.catch(() => undefined);
      return run as any;
    },
    close: async () => {
      await pg.close();
    },
  };
}

async function openPostgres(url: string): Promise<Db> {
  const pgmod = await import("pg");
  const Pool = (pgmod as any).default?.Pool ?? (pgmod as any).Pool;
  const pool = new Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false }, max: 10 });
  return {
    kind: "postgres",
    query: async (sql, params) => ({ rows: (await pool.query(sql, params)).rows }),
    exec: async (sql) => {
      await pool.query(sql);
    },
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn({ query: async (s: string, p?: unknown[]) => ({ rows: (await client.query(s, p)).rows }) });
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
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
CREATE UNIQUE INDEX IF NOT EXISTS calls_one_open_per_obligation ON calls(obligation_id) WHERE status IN ('planned','blocked','ringing','in_progress');
CREATE TABLE IF NOT EXISTS callbacks (
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL, call_id TEXT NOT NULL REFERENCES calls(id), customer_id TEXT NOT NULL, at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pay_links (
  id TEXT PRIMARY KEY, business_id TEXT NOT NULL, obligation_id TEXT NOT NULL REFERENCES obligations(id), call_id TEXT, paypal_order_id TEXT, approve_url TEXT,
  amount_cents INTEGER NOT NULL, status TEXT NOT NULL, request_id TEXT UNIQUE NOT NULL, run_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY, actor TEXT NOT NULL, agent_id TEXT, subject TEXT NOT NULL DEFAULT '', entity TEXT, entity_id TEXT,
  status TEXT NOT NULL DEFAULT 'running', started_at TIMESTAMPTZ NOT NULL DEFAULT now(), ended_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS agent_trace (
  id BIGSERIAL PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id), step INTEGER NOT NULL, actor TEXT NOT NULL, tool TEXT NOT NULL,
  args JSONB, policy TEXT, gate TEXT, result JSONB, pp_request_id TEXT, pp_debug_id TEXT, duration_ms INTEGER, at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_trace_run ON agent_trace(run_id, step);
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
`;

let shared: Db | null = null;

export async function openDb(opts: { memory?: boolean } = {}): Promise<Db> {
  const db = opts.memory ? await openPglite(null) : config.databaseUrl ? await openPostgres(config.databaseUrl) : await openPglite(config.pglitePath);
  await db.exec(SCHEMA);
  return db;
}

export async function getDb(): Promise<Db> {
  if (!shared) shared = await openDb();
  return shared;
}

export function setDb(db: Db) {
  shared = db;
}
