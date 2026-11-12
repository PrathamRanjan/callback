import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Accessibility, ArrowRight, BellRing, Bot, Check, ChevronDown, Code2, Cpu, HeartHandshake, Lightbulb, Palette, Phone, ScrollText, ShieldCheck, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PublicShell } from "@/components/app/public-shell";
import { ScamCheck } from "@/components/app/scam-check";
import { Wave } from "@/components/app/wave";
import { useData, useSession, useTitle } from "@/lib/hooks";
import { money } from "@/lib/format";
import { t, tk, tlist } from "@/i18n";

interface Preview {
  business: { name: string; tz: string } | null;
  owed_cents?: number;
  lines?: { name: string; purpose: string; cents: number; ok: boolean; why: string }[];
  call?: { customer: string; outcome: string | null; turns: { who: string; text: string }[]; money: string[] } | null;
}

const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.classList.contains("a11y-calm");

/** Counts up to the live figure once, unless the visitor prefers no motion. */
function Ticker({ cents }: { cents: number }) {
  const [v, setV] = useState(cents);
  const done = useRef(false);
  useEffect(() => {
    if (done.current || still()) return setV(cents);
    done.current = true;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / 900);
      setV(Math.round(cents * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cents]);
  return <span className="num">{money(v)}</span>;
}

const TURNS = () => [
  { who: "agent", text: t("Hi Priya, this is Callback, an AI assistant calling for Brightside Physio. Is now a good time?") },
  { who: "customer", text: t("Sure, what's it about?") },
  { who: "agent", text: t("Your $60 deposit for tomorrow's 10am session is still open. I can text you a PayPal link now.") },
  { who: "customer", text: t("Yes please, send it.") },
];

/** The hero: how one call goes, turn by turn, with the three lanes lighting as the money moves. It is the same call the
 *  walkthrough hands you as Priya; amounts and checks are the seed's real ones. */
function CallConsole({ data }: { data: Preview | undefined }) {
  const turns = TURNS();
  const [step, setStep] = useState(0);
  const total = turns.length + 3;
  useEffect(() => {
    if (still()) return setStep(total);
    let i = 0;
    const id = window.setInterval(() => {
      i = i >= total + 3 ? 0 : i + 1; // a pause at the end, then it plays again
      setStep(Math.min(i, total));
    }, 1300);
    return () => window.clearInterval(id);
  }, [total]);
  const who = "Priya Natarajan";
  const lanes = [
    { icon: Bot, k: t("AI proposes"), v: t("Send a pay link for the $60.00 deposit"), s: "ready" },
    { icon: Code2, k: t("Code decides"), v: t("Consent, calling hours, $60.00 matches the record, under your $300 limit"), s: "hold" },
    { icon: Wallet, k: t("PayPal moves"), v: t("Order created, Priya pays, captured and read back"), s: "done" },
  ];
  return (
    <figure className="cb-console relative" aria-label={t("How a Callback call goes")}>
      <div className="flex items-center gap-3 border-b border-white/10 px-5 py-3.5">
        <span className="flex size-9 items-center justify-center rounded-full bg-white/10"><Phone className="size-4" aria-hidden="true" /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.95rem] font-semibold">{who}</div>
          <div className="truncate text-xs text-console-ink-2">{data?.business?.name ?? "Brightside Physio & Pilates"} · {t("deposit for tomorrow's 10am session")}</div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 font-mono text-[0.7rem] uppercase tracking-wider"><span className="cb-rec" aria-hidden="true" />{t("Live")}</span>
      </div>
      <div className="px-5 pt-4"><Wave live={step < turns.length} /></div>
      <ol className="min-h-[13.5rem] space-y-2 px-5 py-4 text-[0.92rem]" aria-hidden="true">
        {turns.map((x, i) => (
          <li key={i} className={`cb-bubble ${x.who === "agent" ? "is-agent" : "is-them"} ${step > i ? "is-on" : ""}`}>
            <span>{x.text}</span>
          </li>
        ))}
      </ol>
      <ol className="sr-only">
        {turns.map((x, i) => <li key={i}>{x.who === "agent" ? t("Agent") : who}: {x.text}</li>)}
      </ol>
      <ul className="grid gap-px overflow-hidden rounded-b-[22px] border-t border-white/10 bg-white/10 sm:grid-cols-3">
        {lanes.map((l, i) => (
          <li key={l.k} className={`cb-lane ${step > turns.length + i ? "is-on" : ""}`} data-s={l.s}>
            <div className="flex items-center gap-2 font-mono text-[0.68rem] uppercase tracking-wider text-console-ink-2"><l.icon className="size-3.5" aria-hidden="true" />{l.k}</div>
            <div className="mt-1 text-[0.82rem] leading-snug">{l.v}</div>
          </li>
        ))}
      </ul>
    </figure>
  );
}

const H2 = "font-display text-[clamp(1.8rem,4.2vw,2.7rem)] font-[700]";

function Section({ id, eyebrow, title, lead, children }: { id: string; eyebrow?: string; title: string; lead?: string; children: React.ReactNode }) {
  return (
    <section className="mx-auto max-w-[1180px] px-4 py-16 md:py-24" aria-labelledby={id}>
      {eyebrow ? <p className="cb-eyebrow">{eyebrow}</p> : null}
      <h2 id={id} className={`max-w-[760px] ${H2}`}>{title}</h2>
      {lead ? <p className="mt-3 max-w-[680px] text-lead leading-relaxed text-ink-2">{lead}</p> : null}
      <div className="mt-10">{children}</div>
    </section>
  );
}

const STACK = ["PayPal", "OpenAI", "Twilio", "Telegram", "Render", "MediaPipe", "ONNX Runtime", "WebAuthn", "MCP"];

const WHY = () => [
  { t: t("Deposits go unpaid"), d: t("A booking without its deposit is a no-show waiting to happen. Someone has to ring the day before, and between clients nobody does.") },
  { t: t("Invoices age quietly"), d: t("An overdue invoice needs a person on the phone who can offer a plan. An email reminder gets archived; a call gets an answer.") },
  { t: t("Customers fear payment texts"), d: t("Scam texts taught people not to tap a pay link. So the call says it's an AI, gives a code the customer can check, and pays only through PayPal.") },
];

const FEATURES = () => [
  { icon: Phone, t: t("Real phone calls"), d: t("A voice agent that says it's an AI, explains what's owed and offers only what you allow. In the browser or on a real phone, in four languages."), tech: ["gpt-live-1 · WebRTC", "Twilio Media Streams"] },
  { icon: ScrollText, t: t("Rules in plain words"), d: t("Write your policy the way you'd say it. It becomes typed rules, clamped to legal calling hours and backtested on 90 days of past calls."), tech: ["gpt-6.1-sol", t("typed policy + backtest")] },
  { icon: BellRing, t: t("Approvals that find you"), d: t("Anything over your limit waits for you, on Approvals, as a phone notification or in Telegram with Approve and Decline buttons."), tech: ["Telegram Bot API", "Web Push PWA", "WebAuthn passkey"] },
  { icon: ShieldCheck, t: t("A scam guard on both sides"), d: t("Messages are read by four checks before anything is called safe, including a model that runs on the customer's own device."), tech: ["MiniLM · ONNX Runtime Web", "gpt-6-luna Decisions"] },
  { icon: Bot, t: t("Ask, and bring your own agent"), d: t("Ask questions in plain words and watch each tool it uses. Claude or any MCP client can connect, with the same limits as Callback's own agent."), tech: [t("Callback MCP server"), t("PayPal MCP (read-only)")] },
  { icon: Accessibility, t: t("Built for everyone"), d: t("Screen readers, 200% text, calm mode, high contrast, and hands-free Look and Say: look at a button and say its name."), tech: ["MediaPipe · on-device", "WCAG 2.2 AA"] },
  { icon: Wallet, t: t("PayPal from end to end"), d: t("Pay links, saved wallets, invoices, payment plans and refunds, kept in step by verified webhooks and read back before the record changes."), tech: ["Orders v2 · Vault", "Invoicing v2", "Subscriptions", "Webhooks"] },
];

const CRITERIA = () => [
  {
    icon: Cpu, k: t("Technological implementation"),
    pts: [
      t("Every money move passes one gate in code; the model's tools have no amount field."),
      t("Eight PayPal APIs, each call made with a fixed request id and read back."),
      t("60 scripted customers and 25 attacks run against every build, with results published."),
    ],
    link: { to: "/proof", label: t("See the evidence") },
  },
  {
    icon: Palette, k: t("Design"),
    pts: [
      t("One calm system from the first screen to the customer's pay page, light and dark."),
      t("Every figure is tabular and every status has a shape and a word, never colour alone."),
      t("A guided walkthrough that hands you the phone as the customer, then back to the owner."),
    ],
    link: { to: "/try", label: t("Take the walkthrough") },
  },
  {
    icon: HeartHandshake, k: t("Potential impact"),
    pts: [
      t("Aimed at small businesses that run on bookings and get paid late."),
      t("The customer side needs no app and no account: a call, a code, a PayPal page."),
      t("Usable by screen reader, by voice, at large text and in four languages."),
    ],
    link: { to: "/accessibility", label: t("What was tested") },
  },
  {
    icon: Lightbulb, k: t("Innovation"),
    pts: [
      t("An AI that makes outbound money calls, with a person's limits enforced in code."),
      t("A scam model that runs in the customer's browser, so the warning arrives before the tap."),
      t("Outside agents, over MCP, held to exactly the same gate as Callback's own."),
    ],
    link: { to: "/who-can-move-money", label: t("Who can move money") },
  },
];

const TRACKS = () => [
  { k: t("Best Use of PayPal + AI"), v: t("The AI talks; PayPal Orders, Vault, Invoicing, Subscriptions and refunds settle, behind a gate the model cannot widen.") },
  { k: t("Best Use of Agentic Commerce"), v: t("An agent that negotiates within your rules, plus an MCP server so any agent can propose a payment you approve.") },
  { k: t("Most Impactful"), v: t("Small businesses get paid on time, and their customers get a way to tell a real call from a scam.") },
  { k: t("Render"), v: t("One Blueprint (render.yaml): web service, health checks, and a private Postgres schema for every visitor's demo.") },
];

const PLANS = () => [
  { n: t("Solo"), p: "$0", d: t("For trying it on your own bookings."), f: [t("25 calls a month"), t("Rules, approvals and the scam guard"), t("Pay links and invoices through PayPal")], hi: false },
  { n: t("Studio"), p: "$39", d: t("For a studio, clinic or salon with a front desk."), f: [t("300 calls a month"), t("Real phone line and four languages"), t("Telegram approvals and passkey sign-off"), t("Payment plans and refunds")], hi: true },
  { n: t("Group"), p: "$99", d: t("For several locations or a busy team."), f: [t("1,500 calls a month"), t("Staff seats and several locations"), t("MCP access for your own agents"), t("Audit log export")], hi: false },
];

const FAQ = tlist([
  { q: "Does the AI decide how much to charge?", a: "No. Amounts come from your records. The AI can only pick from options your rules allow, and a separate gate re-checks every amount against the record, your limits and PayPal before anything moves." },
  { q: "Who does it call, and when?", a: "Only customers with consent on file, inside the calling hours you set, in their own time zone, once a day at most. Anyone who says stop is never called again." },
  { q: "What happens with big amounts or refunds?", a: "Anything over your limits waits for you on Needs you, with the amount, the customer, the reason and how to undo it. You can require a passkey above a threshold." },
  { q: "What if someone pretends to be my studio?", a: "Every Callback call gives the customer a short code they can check on their own page. The scam guard flags messages that use pressure or ask for gift cards or codes." },
  { q: "Is the demo real?", a: "PayPal is the real sandbox: orders, invoices, plans and refunds are created there and read back. The demo phone line is a simulator unless a number is on the allowlist, and the studio clock is pinned to one morning." },
], ["q", "a"]);

export default function Landing() {
  useTitle("");
  const { session } = useSession();
  const { data } = useData<Preview>("/api/app/preview");
  const [open, setOpen] = useState<number | null>(0);
  const ready = (data?.lines ?? []).filter((l) => l.ok).length;
  return (
    <PublicShell wide>
      <section className="cb-hero relative">
        <div className="mx-auto grid max-w-[1180px] items-center gap-12 px-4 pb-16 pt-12 md:pt-20 lg:grid-cols-[1.05fr_1fr] lg:pb-24">
          <div className="min-w-0 max-w-[620px]">
            <p className="cb-chip"><span className="lamp scale-75" data-s="live" aria-hidden="true" />{t("For studios, clinics and salons that take bookings")}</p>
            <h1 className="mt-5 font-display text-[clamp(2.4rem,6.4vw,4.3rem)] font-[750] leading-[0.98]">
              {t("The money calls you keep putting off, made for you.")}
            </h1>
            <p className="mt-6 text-lead leading-relaxed text-ink-2">
              {t("Callback phones customers about deposits, overdue invoices and classes you had to cancel, then settles each one through PayPal. The AI does the talking. Your rules decide what money may move.")}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button size="lg" className="h-12 px-6 text-base" asChild>
                <Link to="/try">{t("Try the live demo")} <ArrowRight /></Link>
              </Button>
              {session?.me ? (
                <Button size="lg" variant="outline" className="h-12 px-6 text-base" asChild>
                  <Link to="/today">{t("Back to your studio")}</Link>
                </Button>
              ) : (
                <Button size="lg" variant="outline" className="h-12 px-6 text-base" asChild>
                  <a href="#why">{t("Why it exists")}</a>
                </Button>
              )}
            </div>
            <p className="mt-4 text-sm text-ink-2">{t("No sign-up. You pick a role, we tell you who you are, and a short walkthrough shows you around. Payments run on the real PayPal sandbox.")}</p>
            <p className="mt-1 text-sm text-ink-2">{t("Works with a screen reader, at 200% text, and by voice.")}{" "}<Link to="/accessibility" className="inline-flex min-h-11 items-center underline">{t("What was tested")}</Link></p>
            {data?.business ? (
              <dl className="mt-6 grid max-w-[460px] grid-cols-2 gap-3">
                <div className="cb-stat"><dt>{t("Owed to the studio right now")}</dt><dd className="font-display text-[1.6rem] font-[700]"><Ticker cents={data.owed_cents ?? 0} /></dd></div>
                <div className="cb-stat"><dt>{t("Calls its rules allow today")}</dt><dd className="font-display text-[1.6rem] font-[700] num">{ready}</dd></div>
              </dl>
            ) : null}
          </div>
          <div className="min-w-0"><CallConsole data={data ?? undefined} /></div>
        </div>
        <div className="border-y border-line bg-surface/70">
          <ul className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-center gap-x-7 gap-y-2 px-4 py-4 font-mono text-[0.78rem] uppercase tracking-[0.14em] text-ink-2" aria-label={t("Built on")}>
            <li className="text-ink">{t("Built on")}</li>
            {STACK.map((s) => <li key={s}>{s}</li>)}
          </ul>
        </div>
      </section>

      <Section id="why" eyebrow={t("Why it exists")} title={t("Small businesses lose money in the calls nobody has time to make.")} lead={t("The owner is with a client. The front desk is booking the next one. So the deposit, the overdue invoice and the refund for a cancelled class wait, and some never get paid.")}>
        <ol className="grid gap-4 md:grid-cols-3">
          {WHY().map((w, i) => (
            <li key={w.t} className="cb-card p-6">
              <div className="font-mono text-sm text-brand num">0{i + 1}</div>
              <h3 className="mt-3 text-[1.2rem] font-[650]">{w.t}</h3>
              <p className="mt-2 text-ink-2">{w.d}</p>
            </li>
          ))}
        </ol>
      </Section>

      <section className="border-y border-line bg-surface" aria-labelledby="how">
        <div className="mx-auto max-w-[1180px] px-4 py-16 md:py-24">
          <p className="cb-eyebrow">{t("The product")}</p>
          <h2 id="how" className={H2}>{t("How it works")}</h2>
          <ol className="cb-steps mt-10 grid gap-8 md:grid-cols-3">
            {[
              { n: "1", t: t("It finds who to call"), d: t("Each morning it reads your bookings and invoices: deposits due before an appointment, invoices past due, classes you cancelled. Rules decide who may be called today.") },
              { n: "2", t: t("It makes the call"), d: t("A friendly voice agent explains what's owed, offers only what you allow (a pay link, an invoice, a plan, a credit) and books a call-back if now is bad.") },
              { n: "3", t: t("PayPal settles it"), d: t("The customer pays by PayPal link or invoice; refunds go back the same way. Callback reads PayPal back so your records match what really happened.") },
            ].map((s) => (
              <li key={s.n} className="relative">
                <div className="relative z-[1] flex size-11 items-center justify-center rounded-full bg-brand font-display text-lg font-[700] text-brand-ink num">{s.n}</div>
                <h3 className="mt-4 text-[1.2rem] font-[650]">{s.t}</h3>
                <p className="mt-2 text-ink-2">{s.d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <Section id="trust" eyebrow={t("The safety model")} title={t("The AI proposes. Code decides. PayPal moves.")} lead={t("Three lanes, kept apart on purpose. You can see all three on every call.")}>
        <div className="grid gap-4 md:grid-cols-3">
          {[
            { icon: Bot, t: t("AI proposes"), s: "ready" as const, d: t("The model writes the next line and suggests an option. Its output schema has no amount fields, and any dollar figure it invents is caught and replaced.") },
            { icon: Code2, t: t("Code decides"), s: "hold" as const, d: t("A gate checks consent, hours, the amount on record, your limits, kill switches and a scam screen. Big moves wait for you.") },
            { icon: Wallet, t: t("PayPal moves"), s: "done" as const, d: t("Only then does it call PayPal, with a fixed request id so a retry never charges twice, and reads the result back.") },
          ].map((x, i) => (
            <div key={x.t} className="cb-card relative p-6">
              <div className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-[12px] bg-brand-soft text-brand"><x.icon className="size-5" aria-hidden="true" /></span>
                <h3 className="text-[1.15rem] font-[650]">{x.t}</h3>
                <span className="lamp ml-auto" data-s={x.s} aria-hidden="true" />
              </div>
              <p className="mt-3 text-ink-2">{x.d}</p>
              {i < 2 ? <ArrowRight className="absolute -right-[18px] top-1/2 z-[1] hidden size-8 -translate-y-1/2 rounded-full border border-line bg-surface p-1.5 text-ink-2 md:block" aria-hidden="true" /> : null}
            </div>
          ))}
        </div>
      </Section>

      <section className="cb-dark" aria-labelledby="features">
        <div className="mx-auto max-w-[1180px] px-4 py-16 md:py-24">
          <p className="cb-eyebrow is-dark">{t("What's inside")}</p>
          <h2 id="features" className={`max-w-[760px] ${H2}`}>{t("Everything a small business needs to get paid by phone.")}</h2>
          <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES().map((f, i) => (
              <li key={f.t} className={`cb-feature ${i === 0 ? "lg:col-span-2" : ""}`}>
                <f.icon className="size-6 text-[var(--console-accent)]" aria-hidden="true" />
                <h3 className="mt-4 text-[1.15rem] font-[650]">{f.t}</h3>
                <p className="mt-2 text-console-ink-2">{f.d}</p>
                <ul className="mt-4 flex flex-wrap gap-1.5" aria-label={t("Built with")}>
                  {f.tech.map((x) => <li key={x} className="rounded-full border border-white/15 px-2.5 py-0.5 font-mono text-[0.7rem]">{x}</li>)}
                </ul>
                {i === 0 ? <Wave bars={48} live className="mt-6 hidden lg:flex" /> : null}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <Section id="criteria" eyebrow={t("For the judges")} title={t("Why Callback deserves to win.")} lead={t("Each claim below links to something you can open and check, in the app or in the public evidence.")}>
        <div className="grid gap-4 md:grid-cols-2">
          {CRITERIA().map((c) => (
            <div key={c.k} className="cb-card flex flex-col p-6">
              <div className="flex items-center gap-3">
                <span className="flex size-10 flex-none items-center justify-center rounded-[12px] bg-brand text-brand-ink"><c.icon className="size-5" aria-hidden="true" /></span>
                <h3 className="text-[1.2rem] font-[650]">{c.k}</h3>
              </div>
              <ul className="mt-4 space-y-2.5">
                {c.pts.map((p) => <li key={p} className="flex gap-2.5 text-ink-2"><Check className="mt-1 size-4 flex-none text-brand" aria-hidden="true" /><span>{p}</span></li>)}
              </ul>
              <Link to={c.link.to} className="mt-auto inline-flex min-h-11 items-center gap-1.5 pt-4 font-semibold text-brand underline-offset-4 hover:underline">{c.link.label}<ArrowRight className="size-4" aria-hidden="true" /></Link>
            </div>
          ))}
        </div>
        <h3 className="mt-12 text-[1.1rem] font-[650]">{t("Tracks it's built for")}</h3>
        <dl className="mt-4 grid gap-px overflow-hidden rounded-[16px] border border-line bg-line sm:grid-cols-2">
          {TRACKS().map((x) => (
            <div key={x.k} className="bg-surface p-5">
              <dt className="font-mono text-[0.75rem] uppercase tracking-wider text-brand">{x.k}</dt>
              <dd className="mt-1.5 text-ink-2">{x.v}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <section className="border-y border-line bg-surface" aria-labelledby="pricing">
        <div className="mx-auto max-w-[1180px] px-4 py-16 md:py-24">
          <p className="cb-eyebrow">{t("Planned pricing")}</p>
          <h2 id="pricing" className={H2}>{t("Pricing")}</h2>
          <p className="mt-3 max-w-[680px] text-lead leading-relaxed text-ink-2">{t("What we plan to charge after the hackathon. The demo is free, and PayPal's usual fees apply to payments.")}</p>
          <ul className="mt-10 grid gap-4 lg:grid-cols-3">
            {PLANS().map((p) => (
              <li key={p.n} className={`cb-card flex flex-col p-6 ${p.hi ? "ring-2 ring-brand" : ""}`}>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-[1.2rem] font-[650]">{p.n}</h3>
                  {p.hi ? <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-semibold text-brand">{t("Most studios")}</span> : null}
                </div>
                <p className="mt-1 text-sm text-ink-2">{p.d}</p>
                <p className="mt-5 flex items-baseline gap-1.5"><span className="font-display text-[2.6rem] font-[750] leading-none num">{p.p}</span><span className="text-sm text-ink-2">{t("per month")}</span></p>
                <ul className="mt-5 space-y-2">
                  {p.f.map((f) => <li key={f} className="flex gap-2.5"><Check className="mt-1 size-4 flex-none text-brand" aria-hidden="true" /><span>{f}</span></li>)}
                </ul>
                <Button className="mt-auto w-full" variant={p.hi ? "default" : "outline"} asChild><Link to="/try" className="mt-6">{t("Try the demo")}</Link></Button>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mx-auto max-w-[860px] px-4 py-16 md:py-24" aria-labelledby="try-scam">
        <p className="cb-eyebrow">{t("Try it here")}</p>
        <h2 id="try-scam" className={H2}>{t("Try the scam check")}</h2>
        <p className="mt-3 text-ink-2">{t("Paste any message. A scam model trained for this project scores it in your browser. Nothing you paste leaves this page. The model downloads once (23 MB).")}</p>
        <div className="mt-6"><ScamCheck deviceOnly label={tk("Message to check")} note={t("Checked on this device only. Inside the app, rules, an AI check and a comparison with the business's record also run; green appears only when all of them ran.")} /></div>
      </section>

      <section className="mx-auto max-w-[860px] px-4 pb-16 md:pb-24" aria-labelledby="faq">
        <h2 id="faq" className={H2}>{t("Questions")}</h2>
        <div className="mt-6 divide-y divide-line overflow-hidden rounded-[16px] border border-line bg-surface">
          {FAQ.map((f, i) => (
            <div key={f.q}>
              <h3>
                <button type="button" className="flex min-h-14 w-full items-center justify-between gap-3 px-5 py-4 text-left text-[1.02rem] font-semibold" aria-expanded={open === i} aria-controls={`faq-${i}`} onClick={() => setOpen(open === i ? null : i)}>
                  {f.q}
                  <ChevronDown className={`size-5 flex-none transition-transform ${open === i ? "rotate-180" : ""}`} aria-hidden="true" />
                </button>
              </h3>
              <div id={`faq-${i}`} hidden={open !== i} className="px-5 pb-5 text-ink-2">{f.a}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="px-4 pb-16">
        <div className="cb-console mx-auto flex max-w-[1180px] flex-col items-start gap-6 p-8 md:flex-row md:items-center md:justify-between md:p-12">
          <div className="min-w-0">
            <h2 className="font-display text-[clamp(1.6rem,3.6vw,2.4rem)] font-[700]">{t("See a real sandbox payment go through.")}</h2>
            <p className="mt-2 text-console-ink-2">{t("Pick who you want to be. It takes a few seconds.")}</p>
            <Wave bars={40} live className="mt-5 max-w-[420px]" />
          </div>
          <Button size="lg" className="h-12 bg-[var(--console-accent)] px-6 text-base text-[var(--console)] hover:bg-[var(--console-accent)]/90" asChild>
            <Link to="/try">{t("Try the live demo")}{" "}<ArrowRight /></Link>
          </Button>
        </div>
      </section>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-x-5 gap-y-2 px-4 py-8 text-sm text-ink-2">
          <span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-4" aria-hidden="true" />{t("Sandbox only. No real money moves.")}</span>
          <span className="inline-flex items-center gap-1.5"><Phone className="size-4" aria-hidden="true" />{t("Demo calls use fictional numbers.")}</span>
          <Link className="underline underline-offset-4" to="/proof">{t("Evidence")}</Link>
          <Link className="underline underline-offset-4" to="/paypal">{t("PayPal")}</Link>
          <a className="underline underline-offset-4" href="/llms.txt">{t("llms.txt")}</a>
          <a className="underline underline-offset-4" href="https://github.com/PrathamRanjan/callback">{t("Source")}</a>
        </div>
      </footer>
    </PublicShell>
  );
}
