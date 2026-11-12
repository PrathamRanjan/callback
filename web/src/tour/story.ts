import { driver, type Driver } from "driver.js";
import "driver.js/dist/driver.css";
import { t as tr, tk } from "@/i18n";
import { getJson } from "@/lib/api";

/**
 * The guided walkthrough (the "story"). It is what "Try the live demo" leads to: a card that says who you are, then a
 * few steps across pages that show the product working. Unlike the one-page tours in tours.ts, a story moves between
 * pages: its place is kept in sessionStorage, and the StoryRunner in main.tsx shows the step whose page is open.
 * Leaving the story's pages ends it. Steps where the visitor does something (talk to the agent) let go of the page as
 * soon as they click inside the highlighted part, and a small "Next step" button stays in the corner.
 */
export type StoryKind = "owner" | "customer";
export interface StoryCtx { callId: string | null; token: string | null; name: string }
interface Step {
  path: (c: StoryCtx) => string | null;
  el?: string[];
  title: string;
  body: string;
  /** The visitor acts inside the highlighted part; the page is freed on their first click there. */
  act?: boolean;
  next?: string;
}

const STORIES: Record<StoryKind, Step[]> = {
  owner: [
    {
      path: () => "/today",
      title: tk("You are Maya Chen, the owner"),
      body: tk("You run Brightside Physio & Pilates, a small studio in Sydney. Customers owe you deposits and overdue invoices, and you never have time to ring them. Callback's AI agent makes those calls for you, inside your rules, and PayPal takes the money. In the next three minutes you'll live one day of it."),
      next: tk("Start"),
    },
    { path: () => "/today", el: ["today-kpis"], title: tk("Your day at a glance"), body: tk("What customers owe you right now and what came in today. These numbers come from your bookings and invoices, never from the AI.") },
    { path: () => "/today", el: ["today-ready"], title: tk("The calls your agent will make"), body: tk("Each one passed your rules: the customer agreed to calls, it's within their calling hours, and it's the only try today. Next, you take one of these calls yourself.") },
    {
      path: (c) => (c.callId ? `/calls/${c.callId}` : null),
      el: ["take-call", "call-sim"],
      act: true,
      title: tk("Now you're {0}, the customer"),
      body: tk("This is {0}'s deposit call. Press Talk in the browser and speak to the agent (allow the microphone), or Call my phone to have it ring you. No microphone? Start in simulator and type. Ask for a discount, then agree to pay. Press Next step when you're done."),
    },
    {
      path: (c) => (c.token ? `/c/${c.token}` : null),
      el: ["portal-wallet", "portal"],
      act: true,
      title: tk("The page {0} gets"),
      body: tk("After the call, {0} gets this page. Pay on PayPal's own page and log in with the judge sandbox buyer, or pay as the demo customer from the saved wallet with no login. Both are real PayPal sandbox payments."),
    },
    {
      path: (c) => (c.token ? `/c/${c.token}` : null),
      el: ["portal-check"],
      title: tk("A scam text arrives"),
      body: tk("Someone texts {0}: \"we've moved banks, pay our new PayPal\". Pasted here, it is checked by a model on this device, by rules, by an AI reader and against where the studio really takes payment, and it is held."),
    },
    { path: () => "/approvals", el: ["approvals"], act: true, title: tk("A charge over your limit"), body: tk("A customer agreed to pay more than your limit allows, so the move waits for you: what moves, to whom, why, and how to undo it. Approve or decline it here, or from Telegram.") },
    { path: () => "/money", el: ["money"], title: tk("Money, read back from PayPal"), body: tk("Every pay link, invoice, plan and refund, with PayPal's own order and capture ids. The status comes from PayPal, not from the AI.") },
    { path: () => "/ask", el: ["ask-box"], act: true, title: tk("Ask your agent anything"), body: tk("Try \"Who won't you call today, and why?\". Each tool it uses shows as it works, including PayPal's own MCP server. It can read and propose; it can never move money.") },
    {
      path: () => "/today",
      title: tk("That's a day with Callback"),
      body: tk("Everything you just did happened in your own private copy, on the real PayPal sandbox. Try Call my phone on any planned call, or go back to Try the live demo and be the customer."),
      next: tk("Finish"),
    },
  ],
  customer: [
    {
      path: (c) => (c.token ? `/c/${c.token}` : null),
      title: tk("You are {0}, a customer"),
      body: tk("Brightside Physio & Pilates texted you a link about money you owe them. This is the page it opens: no app, no account. We'll show you around in a minute."),
      next: tk("Start"),
    },
    {
      path: (c) => (c.token ? `/c/${c.token}` : null),
      el: ["portal-wallet", "portal"],
      act: true,
      title: tk("Pay the way you like"),
      body: tk("Pay on PayPal's own page and log in with the judge sandbox buyer, or pay as the demo customer from the saved wallet with no login. A deposit can also be held and charged only if you attend."),
    },
    { path: (c) => (c.token ? `/c/${c.token}` : null), el: ["portal-check"], act: true, title: tk("Got a suspicious message?"), body: tk("Paste it here before you pay. The studio only ever takes payment on this page, through PayPal, so a message asking you to pay somewhere new is held.") },
    {
      path: (c) => (c.token ? `/c/${c.token}` : null),
      title: tk("That's the customer's side"),
      body: tk("Now be the owner: go back to Try the live demo and pick Maya to see the call, the approvals and the money."),
      next: tk("Finish"),
    },
  ],
};

const KEY = "cb-story";
interface State { kind: StoryKind; i: number; ctx: StoryCtx }

function load(): State | null {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as State | null;
    return s && STORIES[s.kind] ? s : null;
  } catch {
    return null;
  }
}
function save(s: State | null) {
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
    else sessionStorage.removeItem(KEY);
  } catch { /* private mode: the story then lasts one page */ }
  mem = s;
}
let mem: State | null = null;
const current = () => load() ?? mem;

let drv: Driver | null = null;
let pill: HTMLElement | null = null;
let token = 0;
let go: (path: string) => void = (p) => window.location.assign(p);

export const storyActive = () => Boolean(current());
/** The router's navigate, so moving between steps is a client-side route change. */
export function setStoryNavigate(fn: (path: string) => void) {
  go = fn;
}

function clearUi() {
  drv?.destroy();
  drv = null;
  pill?.remove();
  pill = null;
}

export function endStory() {
  token++;
  save(null);
  clearUi();
}

/** Finds who the story is about: a deposit call that can still be taken, and that customer's own page. */
export async function storyContext(): Promise<StoryCtx> {
  const calls = await getJson<{ id: string; status: string; purpose: string; customer: { name: string } | null }[]>("/api/app/calls");
  // A call that can be started now comes first (a blocked one, say outside the customer's calling hours, has no Talk
  // button). Priya's deposit call is the seeded one in Sydney, the same call the judge page opens.
  const planned = (x: { status: string }) => x.status === "planned";
  const priya = (x: { customer: { name: string } | null }) => Boolean(x.customer?.name.startsWith("Priya"));
  const c = calls.find((x) => x.purpose === "confirm_deposit" && planned(x) && priya(x))
    ?? calls.find((x) => x.purpose === "confirm_deposit" && planned(x))
    ?? calls.find((x) => planned(x) && x.purpose !== "cancel_class")
    ?? calls.find((x) => x.purpose === "confirm_deposit" && priya(x))
    ?? calls.find((x) => x.purpose === "confirm_deposit")
    ?? null;
  if (!c) return { callId: null, token: null, name: tr("the customer") };
  const d = await getJson<{ customer: { token: string | null; name?: string } }>(`/api/app/calls/${c.id}`);
  return { callId: c.id, token: d.customer.token, name: (c.customer?.name ?? d.customer.name ?? tr("the customer")).split(" ")[0] };
}

/** Starts a story: saves its place and opens the page of its first step. */
export function startStory(kind: StoryKind, ctx: StoryCtx) {
  clearUi();
  token++;
  save({ kind, i: 0, ctx });
  const p = STORIES[kind][0].path(ctx);
  if (p) go(p);
}

const visible = (e: Element) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === "fixed";
function find(keys: string[]): Element | null {
  for (const k of keys) {
    const e = [...document.querySelectorAll(`[data-tour="${k}"], [data-tour="${k}-m"]`)].find(visible);
    if (e) return e;
  }
  return null;
}
async function waitFor(keys: string[], ms = 8000): Promise<Element | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const e = find(keys);
    if (e) return e;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

/** The step to show on this page, or null when the page isn't the story's (which ends it). */
function pathOf(s: State, i: number): string | null {
  const steps = STORIES[s.kind];
  for (let j = i; j < steps.length; j++) {
    const p = steps[j].path(s.ctx);
    if (p) return p;
  }
  return null;
}

/** Moves to step i: on this page it shows straight away; on another page it navigates and the runner shows it. */
function moveTo(i: number) {
  const s = current();
  if (!s) return;
  const steps = STORIES[s.kind];
  if (i < 0) i = 0;
  if (i >= steps.length) return endStory();
  // A step whose page can't be built (no call to take in this demo) is skipped.
  while (i < steps.length && !steps[i].path(s.ctx)) i++;
  if (i >= steps.length) return endStory();
  save({ ...s, i });
  clearUi();
  const p = steps[i].path(s.ctx)!;
  if (window.location.pathname === p) void show();
  else go(p);
}

function showPill(i: number, n: number) {
  pill?.remove();
  const box = document.createElement("div");
  box.className = "cb-story-pill";
  box.setAttribute("role", "region");
  box.setAttribute("aria-label", tr("Walkthrough"));
  const label = document.createElement("span");
  label.textContent = tr("Step {0} of {1}", [i + 1, n]);
  const next = document.createElement("button");
  next.type = "button";
  next.className = "cb-story-next";
  next.textContent = tr("Next step");
  next.onclick = () => moveTo(i + 1);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "cb-story-close";
  close.setAttribute("aria-label", tr("End the walkthrough"));
  close.textContent = "×";
  close.onclick = () => endStory();
  box.append(label, next, close);
  document.body.append(box);
  pill = box;
}

/** Shows the saved step if this page is its page. Called by the runner on every route change. */
export async function show(): Promise<void> {
  const s = current();
  if (!s) return;
  const steps = STORIES[s.kind];
  const step = steps[s.i];
  const p = step ? step.path(s.ctx) : null;
  if (!step || !p) return endStory();
  if (window.location.pathname !== p) {
    // The visitor went somewhere else: the walkthrough is over, the demo stays theirs.
    if (!steps.some((x) => x.path(s.ctx) === window.location.pathname)) endStory();
    return;
  }
  const t = ++token;
  const el = step.el ? await waitFor(step.el) : null;
  if (t !== token) return;
  clearUi();
  const i = s.i;
  const last = i === steps.length - 1;
  const name = s.ctx.name;
  drv = driver({
    popoverClass: step.el ? "cb-tour" : "cb-tour cb-story-card",
    animate: !matchMedia("(prefers-reduced-motion: reduce)").matches && !document.documentElement.classList.contains("a11y-calm"),
    allowClose: true,
    overlayClickBehavior: "none",
    overlayOpacity: step.el ? 0.45 : 0.6,
    stagePadding: 6,
    stageRadius: 10,
    showProgress: true,
    progressText: tr("{0} of {1}", [i + 1, steps.length]),
    showButtons: i === 0 ? ["next", "close"] : ["next", "previous", "close"],
    nextBtnText: step.next ? tr(step.next) : tr("Next"),
    prevBtnText: tr("Back"),
    doneBtnText: step.next ? tr(step.next) : last ? tr("Finish") : tr("Next"),
    onNextClick: () => (last ? endStory() : moveTo(i + 1)),
    onPrevClick: () => moveTo(i - 1),
    onCloseClick: () => endStory(),
    steps: [{ element: el ?? undefined, popover: { title: tr(step.title, [name]), description: tr(step.body, [name]), side: "bottom", align: "start" } }],
  });
  drv.drive();
  if (el) (el as HTMLElement).scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  if (step.act && el) {
    // The first click inside the highlighted part hands the page back; the corner button carries on.
    const free = () => {
      if (t !== token) return;
      drv?.destroy();
      drv = null;
      showPill(i, steps.length);
    };
    el.addEventListener("pointerdown", free, { once: true, capture: true });
    el.addEventListener("keydown", free, { once: true, capture: true });
  }
}
