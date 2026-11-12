import { driver, type Driver } from "driver.js";
import "driver.js/dist/driver.css";
import { t as tr, tk } from "@/i18n";

/**
 * Tours (spec A3.3). A tour starts only from a button, runs on one page, never calls the router, and ends on any
 * route change (the Tours component in main.tsx calls endTour). Targets are `data-tour` attributes; on phones the
 * `-m` twin (bottom nav) is used when the desktop target is hidden. A missing target falls back to a centred card.
 * The old cross-page judge tour is gone: /judge lists the paths, and each step there is a plain link.
 */
export type TourKind = "owner" | "staff";
interface Step { el?: string; title: string; body: string; side?: "top" | "bottom" | "left" | "right" }

export const TOUR_PAGE: Record<TourKind, string> = { owner: "/today", staff: "/calls" };
const TOURS: Record<TourKind, Step[]> = {
  owner: [
    { title: tk("This is your switchboard"), body: tk("Callback makes the awkward money calls for you: deposits before bookings, overdue invoices, refunds for classes you had to cancel. Each lamp is one customer.") },
    { el: "today-kpis", title: tk("What's owed, at a glance"), body: tk("Money still owed, what came in today, and how many calls are ready. The numbers come straight from your records, never from the AI.") },
    { el: "today-needs", title: tk("Anything that needs you"), body: tk("If a call wants to move more money than your limits allow, it stops here. You see what moves, to whom and why, and you say yes or no.") },
    { el: "today-ready", title: tk("Who gets called, and why"), body: tk("Ready calls passed every rule: consent, calling hours in the customer's own time zone, one attempt a day. Blocked ones say which rule stopped them.") },
    { el: "nav-calls", title: tk("Every call, word for word"), body: tk("Open a call to hear the agent, see each check it passed, and every PayPal step it took.") },
    { el: "nav-money", title: tk("Money, from PayPal itself"), body: tk("Pay links, invoices, plans and refunds, read back from PayPal so the status here matches what PayPal says.") },
    { el: "display-help", title: tk("Make it easier to use"), body: tk("Bigger text, stronger contrast, no movement, read aloud. Settings stay on this device.") },
    { el: "take-tour", title: tk("Come back any time"), body: tk("This button replays the tour. That's it: you're ready.") },
  ],
  staff: [
    { title: tk("Hi, front desk"), body: tk("You can see every call and run them from the simulator. Moving money and changing rules stay with the owner.") },
    { el: "calls-list", title: tk("Today's calls"), body: tk("Each row is one customer. The lamp shows its state and the words say why.") },
    { el: "nav-today", title: tk("Today"), body: tk("The day's picture: who is ready, who is blocked, and what was settled.") },
    { el: "nav-proof", title: tk("Proof"), body: tk("How the agent did in tests, and the record of every step it took.") },
    { el: "display-help", title: tk("Make it easier to use"), body: tk("Text size, contrast, calmer motion and read aloud.") },
    { el: "take-tour", title: tk("Replay any time"), body: tk("This button starts the tour again.") },
  ],
};

let drv: Driver | null = null;
let token = 0;

const visible = (e: Element) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === "fixed";
function find(key: string): Element | null {
  const all = [...document.querySelectorAll(`[data-tour="${key}"], [data-tour="${key}-m"]`)];
  return all.find(visible) ?? null;
}
async function waitFor(key: string, ms = 2500): Promise<Element | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const e = find(key);
    if (e) return e;
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

/** Ends any running tour. Called on every route change. */
export function endTour() {
  token++;
  drv?.destroy();
  drv = null;
}

async function show(kind: TourKind, i: number, t: number) {
  const steps = TOURS[kind];
  if (i < 0) i = 0;
  if (i >= steps.length || t !== token) return endTour();
  const s = steps[i];
  const el = s.el ? await waitFor(s.el) : null;
  if (t !== token) return; // a route change ended it while we waited
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
    progressText: tr("{0} of {1}", [i + 1, steps.length]),
    showButtons: ["next", "previous", "close"],
    disableButtons: i === 0 ? ["previous"] : [],
    nextBtnText: tr("Next"),
    prevBtnText: tr("Back"),
    doneBtnText: last ? tr("Finish") : tr("Next"),
    onNextClick: () => void show(kind, i + 1, t),
    onPrevClick: () => void show(kind, i - 1, t),
    onCloseClick: () => endTour(),
    onDestroyStarted: () => endTour(),
    steps: [{ element: el ?? undefined, popover: { title: tr(s.title), description: tr(s.body), side: s.side ?? "bottom", align: "start" } }],
  });
  drv.drive();
  if (el) (el as HTMLElement).scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
}

/** Starts a tour on the page it belongs to. The caller (a button) has already opened that page. */
export function startTour(kind: TourKind) {
  endTour();
  void show(kind, 0, token);
}
export const tourActive = () => Boolean(drv?.isActive());
