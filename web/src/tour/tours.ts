import { driver, type Driver } from "driver.js";
import "driver.js/dist/driver.css";
import { act, getJson } from "@/lib/api";
import { store } from "@/lib/hooks";

/**
 * Tours. Steps can live on different pages: the current step is kept in sessionStorage, so a reload or a
 * navigation mid-tour picks up where it was. Targets are `data-tour` attributes; on phones the `-m` twin (bottom
 * nav) is used when the desktop target is hidden. A missing target falls back to a centred card, never a crash.
 */
type Nav = (to: string) => void;
export type TourKind = "owner" | "staff" | "judge";
interface Step { path?: string | (() => Promise<string | null>); el?: string; title: string; body: string; side?: "top" | "bottom" | "left" | "right" }

let firstCall: string | null = null;
let portal: string | null = null;
async function readyCall(): Promise<string | null> {
  if (firstCall) return `/calls/${firstCall}`;
  try {
    const t = await getJson<{ ready: { id: string; purpose: string }[]; finished: { id: string }[]; live: { id: string }[] }>("/api/app/today");
    const c = t.ready.find((x) => x.purpose === "confirm_deposit") ?? t.ready[0] ?? t.live[0] ?? t.finished[0];
    firstCall = c?.id ?? null;
  } catch {
    firstCall = null;
  }
  return firstCall ? `/calls/${firstCall}` : "/calls";
}
async function customerPage(): Promise<string | null> {
  if (portal) return portal;
  const call = await readyCall();
  if (!call || call === "/calls") return null;
  try {
    const d = await getJson<{ customer: { token: string | null } }>(`/api/app${call}`);
    portal = d.customer.token ? `/c/${d.customer.token}` : null;
  } catch {
    portal = null;
  }
  return portal;
}

/** The owner's page for the customer whose call the tour uses, where a paid booking can be cancelled. */
async function paidCustomer(): Promise<string | null> {
  const call = await readyCall();
  if (!call || call === "/calls") return "/customers";
  try {
    const d = await getJson<{ customer: { id: string } | null }>(`/api/app${call}`);
    return d.customer ? `/customers/${d.customer.id}` : "/customers";
  } catch {
    return "/customers";
  }
}

/** A customer page with an open invoice small enough to split under the rules (the smallest such one). */
let planPage: string | null = null;
async function planPortal(): Promise<string | null> {
  if (planPage) return planPage;
  try {
    const list = await getJson<{ id: string; owed_cents: number }[]>("/api/app/customers");
    for (const c of list.filter((x) => x.owed_cents >= 10000).sort((a, b) => a.owed_cents - b.owed_cents)) {
      const d = await getJson<{ customer: { link: string | null }; items: { kind: string; status: string }[] }>(`/api/app/customers/${c.id}`);
      if (d.customer.link && d.items.some((i) => i.kind === "invoice" && i.status === "open")) return (planPage = d.customer.link);
    }
  } catch {
    /* fall through to the centred card */
  }
  return null;
}

const TOURS: Record<TourKind, Step[]> = {
  owner: [
    { path: "/today", title: "This is your switchboard", body: "Callback makes the awkward money calls for you: deposits before bookings, overdue invoices, refunds for classes you had to cancel. Each lamp is one customer." },
    { path: "/today", el: "today-kpis", title: "What's owed, at a glance", body: "Money still owed, what came in today, and how many calls are ready. The numbers come straight from your records, never from the AI." },
    { path: "/today", el: "today-needs", title: "Anything that needs you", body: "If a call wants to move more money than your limits allow, it stops here. You see what moves, to whom and why, and you say yes or no." },
    { path: "/today", el: "today-ready", title: "Who gets called, and why", body: "Ready calls passed every rule: consent, calling hours in the customer's own time zone, one attempt a day. Blocked ones say which rule stopped them." },
    { path: "/today", el: "nav-calls", title: "Every call, word for word", body: "Open a call to hear the agent, see each check it passed, and every PayPal step it took." },
    { path: "/today", el: "nav-money", title: "Money, from PayPal itself", body: "Pay links, invoices, plans and refunds, read back from PayPal so the status here matches what PayPal says." },
    { path: "/today", el: "display-help", title: "Make it easier to use", body: "Bigger text, stronger contrast, no movement, read aloud. Settings stay on this device." },
    { path: "/today", el: "take-tour", title: "Come back any time", body: "This button replays the tour. That's it: you're ready." },
  ],
  staff: [
    { path: "/calls", title: "Hi, front desk", body: "You can see every call and run them from the simulator. Moving money and changing rules stay with the owner." },
    { path: "/calls", el: "calls-list", title: "Today's calls", body: "Each row is one customer. The lamp shows its state and the words say why." },
    { path: "/calls", el: "nav-today", title: "Today", body: "The day's picture: who is ready, who is blocked, and what was settled." },
    { path: "/calls", el: "nav-proof", title: "Proof", body: "How the agent did in tests, and the record of every step it took." },
    { path: "/calls", el: "display-help", title: "Make it easier to use", body: "Text size, contrast, calmer motion and read aloud." },
    { path: "/calls", el: "take-tour", title: "Replay any time", body: "This button starts the tour again." },
  ],
  judge: [
    { path: "/today", title: "Judge mode: four minutes", body: "Callback is an AI agent that phones a small studio's customers about money and settles it through PayPal. The AI talks; ordinary code decides what money may move; PayPal moves it. This tour walks every part on the PayPal sandbox: a payment, a refund of that same payment, and a payment plan." },
    { path: "/today", el: "today-kpis", title: "One morning at the demo studio", body: "Seeded demo data for a small physio and Pilates studio. The owed total is the sum of open records; nothing here is a model guess." },
    { path: "/today", el: "today-ready", title: "The planner decides who to call", body: "Before any AI is involved, rules pick the calls: consent on file, inside calling hours in the customer's time zone, one try a day, never someone who said stop. Blocked rows name the rule." },
    { path: readyCall, el: "call-score", title: "The three-lane call score", body: "Voice: what was said. Rules: each check the gate ran. Money: each PayPal step. Read across a row and you see one moment of the call in all three." },
    { path: readyCall, el: "call-sim", title: "Play the customer", body: "Start the call, then type what the customer says, or play a scripted persona. The model proposes the next line; a strict schema keeps money out of its hands." },
    { path: readyCall, el: "money-lane", title: "Live: a PayPal sandbox payment", body: "When the customer agrees, the gate checks the amount against the record and your limits, then creates a real PayPal sandbox order. Open the pay link in the Money lane and pay as the sandbox test buyer; the read-back marks it paid." },
    { path: paidCustomer, el: "cancel-booking", title: "Now the studio cancels", body: "Once the deposit shows paid, tap Cancel booking and give a reason. Callback records the money owed back, tied to the same PayPal payment, and the reason is the only one the agent may give. If you skipped the payment, the button appears once it's paid." },
    { path: customerPage, el: "portal-refund", title: "Live: a PayPal refund", body: "This is the customer's own page, from the link in their text: what they owe, what they're owed, a call-back time and a one-tap stop. Tap Refund and PayPal's Refunds API sends the money back to the payment it came from. It's under the studio's $100 refund limit, so it runs without asking." },
    { path: planPortal, el: "portal-plan", title: "Live: a payment plan", body: "A bigger bill can be split. The choices come from the studio's rules (up to 3 payments, at least $50 each), never from the AI. Pick one and Callback creates a PayPal billing plan and subscription; PayPal opens so the sandbox buyer can approve it." },
    { path: "/approvals", el: "approvals", title: "When it isn't sure, it asks", body: "Anything over your limits waits here: the amount, the customer, the reason and how to undo it. Over $200 needs a passkey countersign once one is registered." },
    { path: "/safety", el: "scam-scan", title: "Scam guard", body: "Paste a message pretending to be the studio. Rules and an on-device model flag pressure tactics, and Callback's own calls give a code the customer can check." },
    { path: "/rules", el: "policy", title: "Rules in plain English", body: "Write how you want calls handled. It compiles into checks, refuses anything unsafe, and replays your history to show what would change." },
    { path: "/proof", el: "proof", title: "Proof, not claims", body: "Persona and attack evals, the trace of every tool call with PayPal debug ids, and a hash-chained audit log you can verify." },
    { path: "/proof", title: "That's Callback", body: "The front desk persona (Jordan) sees calls but never money: try it from Demo controls. Reset the demo from the ribbon at the top any time." },
  ],
};

const KEY = "cb-tour";
interface Live { kind: TourKind; i: number }
let drv: Driver | null = null;
let moving = false;
let nav: Nav = (to) => (window.location.href = to);

const visible = (e: Element) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === "fixed";
function find(key: string): Element | null {
  const all = [...document.querySelectorAll(`[data-tour="${key}"], [data-tour="${key}-m"]`)];
  return all.find(visible) ?? null;
}
async function waitFor(key: string, ms = 3500): Promise<Element | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const e = find(key);
    if (e) return e;
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

function end(kind: TourKind) {
  store.del(KEY, true);
  store.set(`cb-tour-seen-${kind}`, "1");
  drv?.destroy();
  drv = null;
  const u = new URL(window.location.href);
  if (u.searchParams.has("tour")) {
    u.searchParams.delete("tour");
    history.replaceState(null, "", u.pathname + u.search + u.hash);
  }
}

async function show(kind: TourKind, i: number) {
  const steps = TOURS[kind];
  if (i < 0) i = 0;
  if (i >= steps.length) return end(kind);
  store.set(KEY, JSON.stringify({ kind, i } satisfies Live), true);
  const s = steps[i];
  moving = true;
  let el: Element | null = null;
  try {
    const path = typeof s.path === "function" ? await s.path() : s.path;
    if (path && window.location.pathname !== path.split("?")[0]) {
      nav(path);
      await new Promise((r) => setTimeout(r, 60));
    }
    el = s.el ? await waitFor(s.el) : null;
  } finally {
    moving = false;
  }
  drv?.destroy();
  const last = i === steps.length - 1;
  drv = driver({
    popoverClass: "cb-tour",
    animate: !matchMedia("(prefers-reduced-motion: reduce)").matches && !document.documentElement.classList.contains("a11y-calm"),
    allowClose: true,
    overlayOpacity: 0.45,
    stagePadding: 6,
    stageRadius: 10,
    showProgress: true,
    progressText: `${i + 1} of ${steps.length}`,
    showButtons: ["next", "previous", "close"],
    disableButtons: i === 0 ? ["previous"] : [],
    nextBtnText: "Next",
    prevBtnText: "Back",
    doneBtnText: last ? "Finish" : "Next",
    onNextClick: () => void show(kind, i + 1),
    onPrevClick: () => void show(kind, i - 1),
    onCloseClick: () => end(kind),
    onDestroyStarted: () => end(kind),
    steps: [{ element: el ?? undefined, popover: { title: s.title, description: s.body, side: s.side ?? "bottom", align: "start" } }],
  });
  drv.drive();
  if (el) (el as HTMLElement).scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
}

/** Starts a tour. The judge tour signs in as the demo owner first if nobody is signed in. */
export async function startTour(kind: TourKind, navigate: Nav, force = false) {
  nav = navigate;
  if (!force && store.get(`cb-tour-seen-${kind}`)) return;
  store.set(`cb-tour-seen-${kind}`, "1");
  firstCall = null;
  portal = null;
  if (kind === "judge") {
    try {
      const s = await getJson<{ me: { role: string } | null }>("/api/app/session");
      if (s.me?.role !== "owner") await act("/demo/signin-as", { role: "owner" });
    } catch {
      /* the steps still show; pages will ask to sign in */
    }
  }
  await show(kind, 0);
}

/** Called on every page load: carries an in-progress tour across navigation and reloads. */
export function resumeTour(navigate: Nav) {
  nav = navigate;
  const raw = store.get(KEY, true);
  if (!raw || moving || drv?.isActive()) return;
  try {
    const t = JSON.parse(raw) as Live;
    if (TOURS[t.kind]) void show(t.kind, t.i);
  } catch {
    store.del(KEY, true);
  }
}
export const tourActive = () => Boolean(store.get(KEY, true));
