import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Bot, Check, ChevronDown, Code2, Phone, ShieldCheck, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PublicShell } from "@/components/app/public-shell";
import { ScamCheck } from "@/components/app/scam-check";
import { Panel } from "@/components/app/bits";
import { useData, useSession, useTitle } from "@/lib/hooks";
import { money, PURPOSE } from "@/lib/format";

interface Preview {
  business: { name: string; tz: string } | null;
  owed_cents?: number;
  lines?: { name: string; purpose: string; cents: number; ok: boolean; why: string }[];
  call?: { customer: string; outcome: string | null; turns: { who: string; text: string }[]; money: string[] } | null;
}

/** Counts up to the live figure once, unless the visitor prefers no motion. */
function Ticker({ cents }: { cents: number }) {
  const [v, setV] = useState(cents);
  const done = useRef(false);
  useEffect(() => {
    if (done.current || matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.classList.contains("a11y-calm")) return setV(cents);
    done.current = true;
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / 900);
      setV(Math.round(cents * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cents]);
  return <span className="num">{money(v)}</span>;
}

function LivePreview() {
  const { data, loading } = useData<Preview>("/api/app/preview");
  if (loading && !data) return <Panel className="h-[420px] animate-pulse bg-surface-2" aria-label="Loading the live preview" />;
  if (!data?.business) return null;
  return (
    <Panel className="overflow-hidden shadow-[0_1px_0_var(--line),0_24px_60px_-30px_rgb(0_0_0/0.35)]">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-surface-2 px-4 py-2.5 text-sm">
        <span className="inline-flex items-center gap-2 font-medium"><span className="lamp" data-s="live" aria-hidden="true" />Live from the demo studio</span>
        <span className="text-ink-2">{data.business.name}</span>
      </div>
      <div className="px-4 pt-4">
        <div className="text-sm text-ink-2">Owed to the studio right now</div>
        <div className="font-display text-[clamp(1.6rem,10vw,2.4rem)] font-[800] leading-none" style={{ fontStretch: "115%" }}><Ticker cents={data.owed_cents ?? 0} /></div>
      </div>
      <ul className="mt-3 divide-y divide-line border-t border-line" aria-label="This morning's calls">
        {(data.lines ?? []).slice(0, 5).map((l, i) => (
          <li key={i} className="flex items-center gap-3 px-4 py-2.5">
            <span className="lamp" data-s={l.ok ? "ready" : "off"} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="text-[0.95rem] font-medium">{l.name} · {PURPOSE[l.purpose] ?? l.purpose}</div>
              <div className="truncate text-xs text-ink-2">{l.ok ? "Ready to call" : `Not calling: ${l.why}`}</div>
            </div>
            <span className="num text-sm font-medium">{money(l.cents)}</span>
          </li>
        ))}
      </ul>
      {data.call ? (
        <div className="border-t border-line bg-paper px-4 py-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-2">A finished call with {data.call.customer}</div>
          <ol className="space-y-1.5 text-sm">
            {data.call.turns.slice(0, 4).map((t, i) => (
              <li key={i} className={t.who === "agent" ? "pr-8" : "pl-8 text-right"}>
                <span className={`inline-block rounded-[8px] px-2.5 py-1.5 ${t.who === "agent" ? "bg-brand-soft" : "bg-surface-2"}`}>{t.text}</span>
              </li>
            ))}
          </ol>
          {data.call.money[0] ? <p className="mt-2 flex items-center gap-1.5 text-xs font-medium"><Wallet className="size-3.5" />{data.call.money[0]}</p> : null}
        </div>
      ) : null}
    </Panel>
  );
}

const FAQ = [
  { q: "Does the AI decide how much to charge?", a: "No. Amounts come from your records. The AI can only pick from options your rules allow, and a separate gate re-checks every amount against the record, your limits and PayPal before anything moves." },
  { q: "Who does it call, and when?", a: "Only customers with consent on file, inside the calling hours you set, in their own time zone, once a day at most. Anyone who says stop is never called again." },
  { q: "What happens with big amounts or refunds?", a: "Anything over your limits waits for you on Needs you, with the amount, the customer, the reason and how to undo it. You can require a passkey above a threshold." },
  { q: "What if someone pretends to be my studio?", a: "Every Callback call gives the customer a short code they can check on their own page. The scam guard flags messages that use pressure or ask for gift cards or codes." },
  { q: "Is the demo real?", a: "PayPal is the real sandbox: orders, invoices, plans and refunds are created there and read back. The demo phone line is a simulator unless a number is on the allowlist, and the studio clock is pinned to one morning." },
];

export default function Landing() {
  useTitle("");
  const { session } = useSession();
  const [open, setOpen] = useState<number | null>(0);
  return (
    <PublicShell wide>
      <section className="mx-auto grid max-w-[1180px] items-start gap-10 px-4 pb-14 pt-10 md:pt-16 lg:grid-cols-[1.05fr_1fr]">
        <div className="max-w-[600px]">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-sm text-ink-2"><span className="lamp scale-75" data-s="live" aria-hidden="true" />For studios, clinics and salons that take bookings</p>
          <h1 className="font-display text-[2.3rem] font-[800] leading-[1.02] tracking-[-0.01em] md:text-[3.4rem]" style={{ fontStretch: "118%" }}>
            The money calls you keep putting off, made for you.
          </h1>
          <p className="mt-5 text-lead leading-relaxed text-ink-2">
            Callback phones customers about deposits, overdue invoices and classes you had to cancel, then settles each one through PayPal. The AI does the talking. Your rules decide what money may move.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button size="lg" className="h-12 px-6 text-base" asChild>
              <Link to={session?.me ? "/today" : "/try"}>{session?.me ? "Open the studio" : "Try the live demo"} <ArrowRight /></Link>
            </Button>
            <Button size="lg" variant="outline" className="h-12 px-6 text-base" asChild>
              <Link to="/judge">For judges: 3 minutes</Link>
            </Button>
          </div>
          <p className="mt-3 text-sm text-ink-2">No sign-up. The demo uses a seeded Sydney studio and the PayPal sandbox.</p>
          <p className="mt-1 text-sm text-ink-2">Works with a screen reader, at 200% text, and by voice. <Link to="/accessibility" className="inline-flex min-h-11 items-center underline">What was tested</Link></p>
        </div>
        <LivePreview />
      </section>

      <section className="border-y border-line bg-surface" aria-labelledby="how">
        <div className="mx-auto max-w-[1180px] px-4 py-14">
          <h2 id="how" className="font-display text-h2 font-[750]" style={{ fontStretch: "112%" }}>How it works</h2>
          <ol className="mt-6 grid gap-4 md:grid-cols-3">
            {[
              { n: "1", t: "It finds who to call", d: "Each morning it reads your bookings and invoices: deposits due before an appointment, invoices past due, classes you cancelled. Rules decide who may be called today." },
              { n: "2", t: "It makes the call", d: "A friendly voice agent explains what's owed, offers only what you allow (a pay link, an invoice, a plan, a credit) and books a call-back if now is bad." },
              { n: "3", t: "PayPal settles it", d: "The customer pays by PayPal link or invoice; refunds go back the same way. Callback reads PayPal back so your records match what really happened." },
            ].map((s) => (
              <li key={s.n} className="rounded-[10px] border border-line bg-paper p-5">
                <div className="font-display text-[2rem] font-[800] leading-none text-brand num">{s.n}</div>
                <h3 className="mt-3 text-lg font-semibold">{s.t}</h3>
                <p className="mt-1.5 text-ink-2">{s.d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-[1180px] px-4 py-14" aria-labelledby="trust">
        <h2 id="trust" className="font-display text-h2 font-[750]" style={{ fontStretch: "112%" }}>The AI proposes. Code decides. PayPal moves.</h2>
        <p className="mt-2 max-w-[680px] text-ink-2">Three lanes, kept apart on purpose. You can see all three on every call.</p>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {[
            { icon: Bot, t: "AI proposes", s: "ready" as const, d: "The model writes the next line and suggests an option. Its output schema has no amount fields, and any dollar figure it invents is caught and replaced." },
            { icon: Code2, t: "Code decides", s: "hold" as const, d: "A gate checks consent, hours, the amount on record, your limits, kill switches and a scam screen. Big moves wait for you." },
            { icon: Wallet, t: "PayPal moves", s: "done" as const, d: "Only then does it call PayPal, with a fixed request id so a retry never charges twice, and reads the result back." },
          ].map((x) => (
            <Panel key={x.t} className="p-5">
              <div className="flex items-center gap-2"><span className="lamp" data-s={x.s} aria-hidden="true" /><x.icon className="size-5" aria-hidden="true" /><h3 className="text-lg font-semibold">{x.t}</h3></div>
              <p className="mt-2 text-ink-2">{x.d}</p>
            </Panel>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-[820px] px-4 pb-14" aria-labelledby="try-scam">
        <h2 id="try-scam" className="font-display text-h2 font-[750]" style={{ fontStretch: "112%" }}>Try the scam check</h2>
        <p className="mt-2 text-ink-2">Paste any message. A scam model trained for this project scores it in your browser. Nothing you paste leaves this page. The model downloads once (23 MB).</p>
        <div className="mt-4"><ScamCheck deviceOnly label="Message to check" note="Checked on this device only. Inside the app, rules, an AI check and a comparison with the business's record also run; green appears only when all of them ran." /></div>
      </section>

      <section className="mx-auto max-w-[820px] px-4 py-14" aria-labelledby="faq">
        <h2 id="faq" className="font-display text-h2 font-[750]" style={{ fontStretch: "112%" }}>Questions</h2>
        <div className="mt-5 divide-y divide-line rounded-[10px] border border-line bg-surface">
          {FAQ.map((f, i) => (
            <div key={f.q}>
              <h3>
                <button type="button" className="flex min-h-14 w-full items-center justify-between gap-3 px-4 py-3 text-left text-[1.02rem] font-semibold" aria-expanded={open === i} aria-controls={`faq-${i}`} onClick={() => setOpen(open === i ? null : i)}>
                  {f.q}
                  <ChevronDown className={`size-5 flex-none transition-transform ${open === i ? "rotate-180" : ""}`} aria-hidden="true" />
                </button>
              </h3>
              <div id={`faq-${i}`} hidden={open !== i} className="px-4 pb-4 text-ink-2">{f.a}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-line bg-brand text-brand-ink">
        <div className="mx-auto flex max-w-[1180px] flex-col items-start gap-4 px-4 py-12 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="font-display text-h2 font-[750]" style={{ fontStretch: "112%" }}>See a real sandbox payment go through.</h2>
            <p className="mt-1 opacity-90">Pick who you want to be. It takes a few seconds.</p>
          </div>
          <Button size="lg" variant="secondary" className="h-12 bg-brand-ink px-6 text-base text-brand hover:bg-brand-ink/90" asChild>
            <Link to="/try">Try the live demo <ArrowRight /></Link>
          </Button>
        </div>
      </section>
      <footer className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-x-5 gap-y-2 px-4 py-8 text-sm text-ink-2">
        <span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-4" aria-hidden="true" />Sandbox only. No real money moves.</span>
        <span className="inline-flex items-center gap-1.5"><Phone className="size-4" aria-hidden="true" />Demo calls use fictional numbers.</span>
        <a className="underline underline-offset-4" href="/llms.txt">llms.txt</a>
        <a className="underline underline-offset-4" href="https://github.com/PrathamRanjan/callback">Source</a>
      </footer>
    </PublicShell>
  );
}
