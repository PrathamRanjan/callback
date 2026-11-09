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
  },
  currency: (process.env.CB_CURRENCY || "USD").toUpperCase(),
  sessionSecret: process.env.SESSION_SECRET || randomBytes(32).toString("hex"),
  demoMode: bool(process.env.CB_DEMO_MODE, true),
  inlineWorker: bool(process.env.CB_INLINE_WORKER, true),
  workerIntervalMs: num(process.env.CB_WORKER_INTERVAL_MS, 2000),
  /** Model provider (roadmap B.1). OpenAI Responses API with strict JSON schemas; "none" = the scripted rules agent. */
  ai: {
    provider: (process.env.AI_PROVIDER || (process.env.OPENAI_API_KEY ? "openai" : "none")) as "openai" | "none",
    openaiKey: process.env.OPENAI_API_KEY || "",
    openaiBaseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/$/, ""),
    models: {
      read: process.env.OPENAI_MODEL_READ || "gpt-5.5",
      classify: process.env.OPENAI_MODEL_CLASSIFY || "gpt-5.4-mini",
      vision: process.env.OPENAI_MODEL_VISION || "gpt-5.6-luna",
      realtime: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
    },
  },
  /** Telephony (roadmap E.4): Twilio for outbound calls and SMS; a voice-platform webhook secret for Vapi/Retell/Bland events. */
  voice: {
    twilioSid: process.env.TWILIO_ACCOUNT_SID || "",
    twilioToken: process.env.TWILIO_AUTH_TOKEN || "",
    twilioFrom: process.env.TWILIO_FROM_NUMBER || "",
    webhookSecret: process.env.VOICE_WEBHOOK_SECRET || "",
  },
  /** Channels (roadmap B.8): without tokens every message is recorded as simulated and shown in the console. */
  channels: {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramSecret: process.env.TELEGRAM_WEBHOOK_SECRET || "",
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
  guard: {
    countersignAboveCents: num(process.env.CB_COUNTERSIGN_ABOVE_CENTS, 20000),
  },
};

export function paypalBaseUrl(env: "sandbox" | "live" = config.paypal.env): string {
  return env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}
