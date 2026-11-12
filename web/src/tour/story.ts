import { driver, type Driver } from "driver.js";
import "driver.js/dist/driver.css";
import { t as tr, tk } from "@/i18n";
import { getJson, postJson } from "@/lib/api";

/**
 * The guided walkthrough (the "story"). It is what "Try the live demo" leads to: a card that says who you are, then
 * steps across pages that show the product working. Unlike the one-page tours in tours.ts, a story moves between
 * pages: its place is kept in sessionStorage, and the StoryRunner in main.tsx shows the step whose page is open.
 * Leaving the story's pages ends it, and so does Escape; there is no skip button. Steps where the visitor does
 * something (talk to the agent) let go of the page on their first click inside the highlighted part, and a small
 * "Next step" button stays in the corner. Role-switch cards mark the moment you stop being Maya and become Priya.
 * Each step can carry a short note at the bottom on what it shows against the judging criteria.
 */
export type StoryKind = "owner" | "customer";
export interface StoryCtx { callId: string | null; token: string | null; name: string }
type Criterion = "tech" | "impact" | "innovation";
interface Step {
  path: (c: StoryCtx) => string | null;
  el?: string[];
  title: string;
  body: string;
  /** The visitor acts inside the highlighted part; the page is freed on their first click there. */
  act?: boolean;
  next?: string;
  /** A role change: a centred card from one person to the other. */
  from?: string;
  to?: string;
  /** Shown only when its part is on the page (the phone layout has no header button for it, say). */
  optional?: boolean;
  why?: [Criterion, string][];
}

const CRIT: Record<Criterion, string> = { tech: tk("Technology"), impact: tk("Impact"), innovation: tk("Innovation") };
const MAYA = tk("Maya, the owner");
const CUSTOMER = tk("{0}, the customer");

const portal = (c: StoryCtx) => (c.token ? `/c/${c.token}` : null);
const STORIES: Record<StoryKind, Step[]> = {
  owner: [
    {
      path: () => "/today",
      title: tk("You are Maya Chen, the owner"),
      body: tk("You run Brightside Physio & Pilates, a small studio in Sydney. Customers owe you deposits and overdue invoices, and you never have time to ring them. Callback's AI agent makes those calls for you, inside your rules, and PayPal takes the money. In the next few minutes you'll live one day of it."),
      next: tk("Start"),
      why: [["impact", tk("A studio owner chases money by phone between clients. Those calls get put off, and the deposit or invoice goes unpaid.")]],
    },
    {
      path: () => "/today",
      el: ["today-kpis"],
      title: tk("Your day at a glance"),
      body: tk("What customers owe you right now and what came in today. These numbers come from your bookings and invoices, never from the AI."),
      why: [["tech", tk("Every figure is read from the records and from PayPal (Orders v2, Invoicing v2), not written by a model.")]],
    },
    {
      path: () => "/rules",
      el: ["policy"],
      title: tk("Your rules: why it calls, and when"),
      body: tk("You wrote these in plain words. The agent calls only when one applies: a deposit still unpaid before tomorrow's appointment, an invoice more than a week overdue, or a class you cancelled. Before any call, code checks that the customer agreed to calls, that it's within their own calling hours, and that it's the only try today. It may offer up to 10% off or a plan of three payments, and anything over $300 waits for you."),
      why: [
        ["tech", tk("gpt-6.1-sol turns your words into typed rules; code clamps them to the legal calling window and backtests them over 90 days of past calls.")],
        ["innovation", tk("The model can't widen a rule. Whatever it couldn't express is listed for you, not guessed.")],
      ],
    },
    {
      path: () => "/today",
      el: ["today-ready"],
      title: tk("The calls your agent will make"),
      body: tk("Each one passed your rules. Blocked ones say which rule stopped them. Next, you take one of these calls yourself, as the customer."),
    },
    {
      path: (c) => (c.callId ? `/calls/${c.callId}` : null),
      from: MAYA,
      to: CUSTOMER,
      title: tk("Now you're {0}"),
      body: tk("Maya hands you the phone. {0} owes a deposit for tomorrow's appointment, and the agent is about to call. You answer."),
      next: tk("Answer the call"),
    },
    {
      path: (c) => (c.callId ? `/calls/${c.callId}` : null),
      el: ["take-call", "call-sim"],
      act: true,
      title: tk("Take {0}'s call"),
      body: tk("Press Start talking and answer as {0}; the agent says first that it's an AI. Ask for a discount, then agree to pay. Or type your own number in Call my phone and it rings you. Press Next step when you're done."),
      why: [
        ["tech", tk("gpt-live-1 over WebRTC in the browser, or Twilio Media Streams to your phone. Every money move goes back to the server and through one gate in code.")],
        ["innovation", tk("The model's tools have no amount field. It picks an option; code works out every number.")],
      ],
    },
    {
      path: portal,
      el: ["portal-wallet", "portal"],
      act: true,
      title: tk("The page {0} gets"),
      body: tk("After the call, {0} gets this page, with the same code the agent read out. Pay on PayPal's own page and log in with the judge sandbox buyer, or pay as the demo customer from the saved wallet with no login."),
      why: [["tech", tk("PayPal Orders v2 checkout, or one tap from a saved PayPal wallet (Vault). Both are real sandbox payments, captured and read back.")]],
    },
    {
      path: portal,
      el: ["portal-check"],
      title: tk("A scam text arrives"),
      body: tk("Someone texts {0}: \"we've moved banks, pay our new PayPal\". Pasted here, it is held, never shown as safe."),
      why: [["innovation", tk("Four readers, and green needs all of them: a MiniLM model running in this browser (ONNX, with heads we trained), rules, an AI reader (gpt-6-luna Decisions) and the studio's real place to pay.")]],
    },
    {
      path: () => "/approvals",
      from: CUSTOMER,
      to: MAYA,
      title: tk("Back to Maya"),
      body: tk("You're the owner again. While you were Priya, another customer asked for more than your limit allows."),
      next: tk("Continue"),
    },
    {
      path: () => "/approvals",
      el: ["approvals"],
      act: true,
      title: tk("A charge over your limit"),
      body: tk("Ivy Park asked for her $360 pay link, over your $300 limit, so the gate held it. You see what moves, to whom, why, and how to undo it. Approve or decline it here."),
      why: [["tech", tk("Each approval is bound to a hash of the exact payment, large ones can require your passkey, and every decision lands in a hash-chained audit log.")]],
    },
    {
      path: () => "/messages",
      el: ["messages"],
      title: tk("Holds reach your phone"),
      body: tk("Connect Telegram and held charges arrive in a chat with Approve and Decline buttons, so the customer isn't left waiting. Every message a customer sends in is checked for scams before you see it."),
      why: [["impact", tk("The owner is with a client, not at a desk. One tap in Telegram settles it.")]],
    },
    {
      path: () => "/money",
      el: ["money"],
      title: tk("Money, read back from PayPal"),
      body: tk("Every pay link, invoice, plan and refund, with PayPal's own order and capture ids. The status comes from PayPal, not from the AI."),
      why: [["tech", tk("Orders, captures, Invoicing, Billing plans and Subscriptions, and refunds, kept in step by verified PayPal webhooks.")]],
    },
    {
      path: () => "/ask",
      el: ["ask-box"],
      act: true,
      title: tk("Ask your agent anything"),
      body: tk("Try \"Who won't you call today, and why?\". Each tool it uses shows as it works. It can read and propose; it can never move money."),
      why: [["tech", tk("An agent loop with tools from Callback's own MCP server and PayPal's MCP server, read-only.")]],
    },
    {
      path: () => "/agents",
      el: ["agents"],
      title: tk("Your own assistant can use Callback too"),
      body: tk("Claude or any MCP client connects with a demo key. It can read the plan and propose a payment, which still waits for you, through the same gate."),
      why: [["innovation", tk("Agentic commerce with a person in charge: outside agents get the same limits as Callback's own.")]],
    },
    {
      path: () => "/today",
      el: ["display-help"],
      optional: true,
      title: tk("Built for everyone"),
      body: tk("Bigger text, calm mode and high contrast, four languages (English, Hindi, Indonesian, Brazilian Portuguese, calls included), and hands-free Look and Say: look at a button and say its name."),
      why: [["impact", tk("Look and Say runs on MediaPipe in the browser; no camera image leaves the device.")]],
    },
    {
      path: () => "/today",
      title: tk("That's a day with Callback"),
      body: tk("Everything you just did happened in your own private copy, on the real PayPal sandbox. Evidence lists 60 scripted customers and 25 attacks with every result, and the QR code on For judges opens this demo on your phone."),
      next: tk("Finish"),
      why: [["tech", tk("Runs on Render: one web service, a private Postgres schema for each visitor, health checks and a Blueprint (render.yaml).")]],
    },
  ],
  customer: [
    {
      path: portal,
      title: tk("You are {0}, a customer"),
      body: tk("Brightside Physio & Pilates texted you a link about money you owe them. This is the page it opens: no app, no account."),
      next: tk("Start"),
    },
    {
      path: portal,
      el: ["portal-wallet", "portal"],
      act: true,
      title: tk("Pay the way you like"),
      body: tk("Pay on PayPal's own page and log in with the judge sandbox buyer, or pay as the demo customer from the saved wallet with no login. A deposit can also be held and charged only if you attend."),
      why: [["tech", tk("PayPal Orders v2, with authorize-then-capture for deposit holds and Vault for the saved wallet.")]],
    },
    {
      path: portal,
      el: ["portal-check"],
      act: true,
      title: tk("Got a suspicious message?"),
      body: tk("Paste it here before you pay. The studio only ever takes payment on this page, through PayPal, so a message asking you to pay somewhere new is held."),
      why: [["innovation", tk("Four readers, and green needs all of them: a MiniLM model running in this browser (ONNX, with heads we trained), rules, an AI reader (gpt-6-luna Decisions) and the studio's real place to pay.")]],
    },
    {
      path: portal,
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
let dir: 1 | -1 = 1;
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

// Escape always ends the walkthrough, so a keyboard user is never trapped in it (WCAG 2.1.2).
if (typeof window !== "undefined") window.addEventListener("keydown", (e) => { if (e.key === "Escape" && current()) endStory(); });

/**
 * Gets the demo ready (a reused demo may have paid Priya or decided the hold), then finds who the story is about:
 * Priya's deposit call that can be taken now, and her own page.
 */
export async function storyContext(): Promise<StoryCtx> {
  const ready = await postJson<{ call: string | null }>("/api/app/demo/story-ready", {}).catch(() => ({ call: null }));
  const calls = await getJson<{ id: string; status: string; purpose: string; customer: { name: string } | null }[]>("/api/app/calls");
  const planned = (x: { status: string }) => x.status === "planned";
  const priya = (x: { customer: { name: string } | null }) => Boolean(x.customer?.name.startsWith("Priya"));
  const c = (ready.call ? calls.find((x) => x.id === ready.call) : undefined)
    ?? calls.find((x) => x.purpose === "confirm_deposit" && planned(x) && priya(x))
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
  dir = 1;
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

/** Moves to step i: on this page it shows straight away; on another page it navigates and the runner shows it. */
function moveTo(i: number) {
  const s = current();
  if (!s) return;
  const steps = STORIES[s.kind];
  dir = i < s.i ? -1 : 1;
  if (i < 0) i = 0;
  if (i >= steps.length) return endStory();
  // A step whose page can't be built (no call to take in this demo) is skipped.
  while (i < steps.length && !steps[i].path(s.ctx)) i += dir;
  if (i < 0 || i >= steps.length) return endStory();
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
  box.append(label, next);
  document.body.append(box);
  pill = box;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
/** The body, plus the role change (for a switch card) and the criteria note at the bottom. */
function describe(step: Step, name: string): string {
  const v = [name];
  let out = "";
  if (step.from && step.to) {
    out += `<span class="cb-story-switch" aria-hidden="true"><span class="cb-role cb-role-from">${esc(tr(step.from, v))}</span><span class="cb-role-arrow">→</span><span class="cb-role cb-role-to">${esc(tr(step.to, v))}</span></span>`;
  }
  out += `<span class="cb-story-body">${esc(tr(step.body, v))}</span>`;
  if (step.why?.length) {
    out += `<span class="cb-story-why">${step.why.map(([c, text]) => `<span class="cb-why-row"><span class="cb-why-tag" data-c="${c}">${esc(tr(CRIT[c]))}</span><span>${esc(tr(text, v))}</span></span>`).join("")}</span>`;
  }
  return out;
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
  const el = step.el ? await waitFor(step.el, step.optional ? 2500 : 8000) : null;
  if (t !== token) return;
  if (step.optional && !el) return moveTo(Math.max(0, s.i + dir));
  clearUi();
  const i = s.i;
  const last = i === steps.length - 1;
  const name = s.ctx.name;
  const card = !step.el;
  drv = driver({
    popoverClass: `cb-tour cb-story${card ? " cb-story-card" : ""}${step.from ? " cb-story-switchcard" : ""}`,
    animate: !matchMedia("(prefers-reduced-motion: reduce)").matches && !document.documentElement.classList.contains("a11y-calm"),
    allowClose: false,
    overlayClickBehavior: "none",
    overlayOpacity: card ? 0.6 : 0.45,
    stagePadding: 6,
    stageRadius: 10,
    showProgress: true,
    progressText: tr("{0} of {1}", [i + 1, steps.length]),
    showButtons: i === 0 ? ["next"] : ["next", "previous"],
    nextBtnText: step.next ? tr(step.next) : tr("Next"),
    prevBtnText: tr("Back"),
    doneBtnText: step.next ? tr(step.next) : last ? tr("Finish") : tr("Next"),
    onNextClick: () => (last ? endStory() : moveTo(i + 1)),
    onPrevClick: () => moveTo(i - 1),
    steps: [{ element: el ?? undefined, popover: { title: tr(step.title, [name]), description: describe(step, name), side: "bottom", align: "start" } }],
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
