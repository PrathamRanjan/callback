import { renderShell, type Brand, type NavGroup } from "./shell.js";
/** Minimal safe HTML templating: every interpolated value is escaped unless wrapped in raw(). */
export class Raw {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

export const raw = (s: string) => new Raw(s);

export function esc(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) return v.map(esc).join("");
  return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += esc(values[i]) + strings[i + 1];
  return new Raw(out);
}

/** JSON for an inline <script type="application/json"> block. */
export function jsonBlock(id: string, data: unknown): Raw {
  return raw(`<script type="application/json" id="${esc(id)}">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`);
}

export interface LayoutOpts {
  title: string;
  who?: { name: string; business: string; role: string; clock: string } | null;
  customer?: { business: string } | null;
  head?: Raw;
  scripts?: Raw;
  flash?: { ok?: string; err?: string };
  /** Public landing page: full-width sections. */
  site?: boolean;
}

export const BRAND: Brand = {
  name: "Callback",
  mark: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/><path d="M15 3.5a6 6 0 0 1 5.5 5.5"/><path d="M15 7a2.5 2.5 0 0 1 2 2"/></svg>`,
  description: "Callback: the voice agent that makes a small business's money calls, inside the owner's rules, with PayPal doing the money.",
  themeColor: "#5b2a86",
  fonts: "family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;600",
  appFoot: "PayPal sandbox: no real money moves. Callback speaks inside your rules; every amount comes from your records, never from the conversation.",
  siteLinks: [["/#how", "How it works"], ["/#safety", "Safety"], ["/#try", "Try it"], ["/judge", "Judge tour"]],
  cta: ["/#try", "Try the demo"],
  siteFoot: "Callback · built for the PayPal AI Hackathon · PayPal sandbox only, no real money moves.",
  siteFootLinks: [["/judge", "Judge tour"], ["/llms.txt", "llms.txt"], ["/login", "Sign in with a key"]],
  staticBase: "/static",
  legacyCss: ["app.css"],
};

const NAV_OWNER: NavGroup[] = [
  { label: "Calls", items: [["/today", "Today", "home"], ["/calls", "Calls", "phone"], ["/customers", "Customers", "users"], ["/ops/guard", "Approvals", "shieldCheck"], ["/ops/money", "Money", "wallet"]] },
  { label: "Your rules", items: [["/policy", "Call policy", "file"], ["/safety", "Scam protection", "shield"]] },
  { label: "How it works", items: [["/ops/traces", "Call traces", "layers"], ["/ops/eval", "Test calls", "flask"], ["/ops/channels", "Messages", "message"], ["/ops/evidence", "Evidence", "receipt"], ["/demo", "Demo controls", "gauge"]] },
];
const NAV_STAFF: NavGroup[] = [{ label: "Calls", items: [["/today", "Today", "home"], ["/calls", "Calls", "phone"], ["/customers", "Customers", "users"]] }, { label: "Demo", items: [["/demo", "Demo controls", "gauge"]] }];

export function layout(o: LayoutOpts, body: Raw): string {
  const common = { title: o.title, body: body.value, flash: o.flash, head: `<link rel="manifest" href="/manifest.webmanifest">${o.head?.value ?? ""}`, scripts: `${o.scripts ? o.scripts.value : ""}<script src="/static/pwa.js" defer></script>` };
  if (o.who) {
    return renderShell(BRAND, { ...common, mode: "app", nav: o.who.role === "owner" ? NAV_OWNER : NAV_STAFF, homeHref: "/today", workspace: o.who.business, user: { name: o.who.name, sub: `${o.who.role === "owner" ? "Owner" : "Staff"} · ${o.who.clock}`, logout: "/logout", settings: o.who.role === "owner" ? "/ops/channels#phone" : undefined } });
  }
  if (o.customer) {
    return renderShell(BRAND, { ...common, mode: "customer", business: o.customer.business, trust: `${o.customer.business} takes payment only through PayPal. When we call, we say a verify code that matches the one on this page; if the codes differ, hang up. We never ask for a card number, a password or a one-time code.` });
  }
  return renderShell(BRAND, { ...common, mode: o.site ? "site" : "plain" });
}

export const STATE_CLASS: Record<string, string> = {
  planned: "info", blocked: "warn", ringing: "info", in_progress: "info", ended: "good", skipped: "muted",
  open: "warn", link_sent: "info", invoiced: "info", paid: "good", credited: "good", refunded: "good", void: "muted",
  pending: "warn", approved: "good", declined: "bad", expired: "muted", active: "good", draft: "muted", retired: "muted",
  allowed: "good", denied: "bad", held: "warn", dry_run_refused: "warn", scheduled: "info", done: "good", failed: "bad",
  COMPLETED: "good", APPROVED: "info", CREATED: "muted", SENT: "info", PAID: "good", ACTIVE: "good", APPROVAL_PENDING: "info",
};

export const pill = (state: string, label?: string) => html`<span class="pill ${STATE_CLASS[state] ?? ""}">${label ?? state.replace(/_/g, " ")}</span>`;
export const fmtDate = (v: string | number | Date | null | undefined) => (v ? new Date(v).toISOString().replace("T", " ").slice(0, 16) : "—");
