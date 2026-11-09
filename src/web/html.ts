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
}

export function layout(o: LayoutOpts, body: Raw): string {
  const nav = o.who
    ? [["/today", "Today"], ["/calls", "Calls"], ["/customers", "Customers"], ["/policy", "Call policy"], ["/ops/guard", "Guard"], ["/safety", "Safety"], ["/ops/money", "Money"], ["/ops/traces", "Runs"], ["/ops/eval", "Evals"], ["/ops/channels", "Channels"], ["/ops/evidence", "Evidence"], ["/demo", "Demo"]]
        .filter(([href]) => o.who!.role === "owner" || ["/today", "/calls", "/customers", "/demo"].includes(href))
        .map(([href, label]) => `<a href="${href}">${esc(label)}</a>`)
        .join("")
    : o.customer
      ? ""
      : `<a href="/login">Sign in</a><a href="/judge">Judge mode</a><a href="/demo">Demo</a>`;
  const signout = o.who ? `<span class="muted small" title="Business clock">${esc(o.who.clock)}</span><span class="muted small">${esc(o.who.name)} · ${esc(o.who.business)}</span><form method="post" action="/logout" class="inline"><button class="btn small" type="submit">Sign out</button></form>` : "";
  const flash = o.flash?.ok ? `<div class="banner good" role="status">${esc(o.flash.ok)}</div>` : o.flash?.err ? `<div class="banner bad" role="alert">${esc(o.flash.err)}</div>` : "";
  const brand = o.customer ? `<span class="brand"><span class="dot">${esc(o.customer.business[0])}</span>${esc(o.customer.business)}</span>` : `<a class="brand" href="/"><span class="dot">C</span>Callback</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)} · ${o.customer ? esc(o.customer.business) : "Callback"}</title>
<link rel="icon" href="/static/icon.svg">
<link rel="stylesheet" href="/static/app.css">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#5b2a86">
${o.head ? o.head.value : ""}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="topbar"><div class="wrap">${brand}<nav class="nav" aria-label="Main">${nav}${signout}</nav></div></header>
<main id="main"><div class="wrap">${flash}${body.value}</div></main>
<footer><div class="wrap">${o.customer ? `${esc(o.customer.business)} · Payments are handled by PayPal.` : "Callback · PayPal sandbox only: no real money moves. The agent speaks inside the owner's rules; amounts come from the records, never from the conversation."}</div></footer>
<script src="/static/pwa.js" defer></script>
<link rel="stylesheet" href="/static/a11y.css"><script src="/static/a11y.js" defer></script>
${o.scripts ? o.scripts.value : ""}
</body>
</html>`;
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
