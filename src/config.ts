import { randomBytes } from "node:crypto";

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === "") return dflt;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}
function num(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return v === undefined || v === "" || !Number.isFinite(n) ? dflt : n;
}

const port = num(process.env.PORT, 3500);

export const config = {
  port,
  appUrl: (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/$/, ""),
  databaseUrl: process.env.DATABASE_URL || "",
  pglitePath: process.env.PGLITE_PATH || "./data/pglite",
  paypal: {
    env: (process.env.PAYPAL_ENV || "sandbox") as "sandbox" | "live",
    clientId: process.env.PAYPAL_CLIENT_ID || "",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || "",
    webhookId: process.env.PAYPAL_WEBHOOK_ID || "",
    /** Vault v3 payment token of the demo's saved sandbox buyer wallet (spec A2.1). Demo workspaces only. */
    demoVaultToken: process.env.PAYPAL_DEMO_VAULT_TOKEN || "",
    demoVaultEmail: process.env.PAYPAL_DEMO_VAULT_EMAIL || "",
  },
  /** Private demo workspaces (spec A1): limits that keep a shared free database and the model bill bounded. */
  workspaces: {
    /** On by default in demo mode: every "Try the demo" tap gets its own studio. Tests of the single studio turn it off. */
    enabled: bool(process.env.CB_WORKSPACES, bool(process.env.CB_DEMO_MODE, true)),
    maxLive: num(process.env.CB_MAX_WORKSPACES, 40),
    idleHours: num(process.env.CB_WORKSPACE_IDLE_HOURS, 48),
    startsPerHour: num(process.env.CB_WORKSPACE_STARTS_PER_HOUR, 5),
  },
  /** Operator key for the global reset and the wallet re-approval page. Without it those pages are closed. */
  adminKey: process.env.CB_ADMIN_KEY || "",
  commit: (process.env.RENDER_GIT_COMMIT || process.env.CB_COMMIT || "").slice(0, 12),
  currency: (process.env.CB_CURRENCY || "USD").toUpperCase(),
  sessionSecret: process.env.SESSION_SECRET || randomBytes(32).toString("hex"),
  demoMode: bool(process.env.CB_DEMO_MODE, true),
  inlineWorker: bool(process.env.CB_INLINE_WORKER, true),
  workerIntervalMs: num(process.env.CB_WORKER_INTERVAL_MS, 2000),
  /** Model provider (roadmap B.1). OpenAI Responses API with strict JSON schemas; "none" = the scripted rules agent. */
  ai: {
    /**
     * "openai" is the only provider a deployed server runs. "rules" is the deterministic test and offline-evaluation arm
     * (spec A11): it never runs on the deployed app and is never labelled as AI. "none" means no model: AI steps show
     * an honest failure instead of a stand-in.
     */
    provider: (process.env.AI_PROVIDER || (process.env.OPENAI_API_KEY ? "openai" : "none")) as "openai" | "rules" | "none",
    openaiKey: process.env.OPENAI_API_KEY || "",
    openaiBaseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/$/, ""),
    models: {
      // Spec A5.1: reading and drafting on gpt-6.1-sol (backup gpt-6-sol), small wording jobs on gpt-6-luna.
      read: process.env.OPENAI_MODEL_READ || "gpt-6.1-sol",
      readBackup: process.env.OPENAI_MODEL_READ_BACKUP || "gpt-6-sol",
      classify: process.env.OPENAI_MODEL_CLASSIFY || "gpt-6-luna",
      vision: process.env.OPENAI_MODEL_VISION || "gpt-6.1-sol",
      // Spec B2 / A10: live voice on GPT-Live (full duplex; client delegation sends every decision to our gate).
      live: process.env.OPENAI_LIVE_MODEL || "gpt-live-1",
      liveVoice: process.env.OPENAI_LIVE_VOICE || "marin",
      // Spec A5.2: the Decisions API (probabilities for yes/no, choice and score questions); gpt-6-luna is the only model it takes.
      decisions: process.env.OPENAI_MODEL_DECISIONS || "gpt-6-luna",
    },
  },
  /** Telephony (roadmap E.4): Twilio for outbound calls and SMS; a voice-platform webhook secret for Vapi/Retell/Bland events. */
  voice: {
    twilioSid: process.env.TWILIO_ACCOUNT_SID || "",
    twilioToken: process.env.TWILIO_AUTH_TOKEN || "",
    twilioFrom: process.env.TWILIO_FROM_NUMBER || "",
    webhookSecret: process.env.VOICE_WEBHOOK_SECRET || "",
    /** "Call my phone" (spec B2): ISO country codes it may dial, e.g. "AU,US". Empty = off (the owner decides). */
    callMyPhoneCountries: (process.env.CB_CALL_MY_PHONE_COUNTRIES || "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean),
    /** A live call is cut at this many seconds (spec B2: 4 minutes), by Twilio's TimeLimit and by our own timer. */
    liveCapSeconds: Number(process.env.CB_LIVE_CAP_SECONDS || 240),
  },
  /** Channels (roadmap B.8): without tokens every message is recorded as simulated and shown in the console. */
  channels: {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramSecret: process.env.TELEGRAM_WEBHOOK_SECRET || "",
    telegramBot: process.env.TELEGRAM_BOT_USERNAME || "paypalhackathonbot",
    whatsappToken: process.env.WHATSAPP_TOKEN || "",
    whatsappPhoneId: process.env.WHATSAPP_PHONE_ID || "",
    whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "callback-verify",
    vapidPublic: process.env.VAPID_PUBLIC_KEY || "",
    vapidPrivate: process.env.VAPID_PRIVATE_KEY || "",
  },
  sponsors: {
    bryntumKey: process.env.BRYNTUM_LICENSE_KEY || "",
    agGridKey: process.env.AG_GRID_LICENSE_KEY || "",
    agStudioUrl: process.env.AG_STUDIO_URL || "",
    channel3Key: process.env.CHANNEL3_API_KEY || "",
  },
  /** Demo mode only texts or dials numbers on this list (comma-separated, any spacing); every other message is simulated. */
  liveContactAllowlist: (process.env.CB_LIVE_CONTACT_ALLOWLIST || "").split(",").map((x) => x.replace(/[^0-9+]/g, "")).filter(Boolean),
  guard: {
    countersignAboveCents: num(process.env.CB_COUNTERSIGN_ABOVE_CENTS, 20000),
  },
};

/** In demo mode a real SMS or phone call may only reach a number the operator listed; seeded customers are fiction. */
export function mayContactForReal(phone: string): boolean {
  if (!config.demoMode) return true;
  return config.liveContactAllowlist.includes(phone.replace(/[^0-9+]/g, ""));
}

export function paypalBaseUrl(env: "sandbox" | "live" = config.paypal.env): string {
  return env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}
