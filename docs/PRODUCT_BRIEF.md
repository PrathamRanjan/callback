# Callback product brief

Labels: **[fact]** sourced, **[est]** estimate from a source or simple arithmetic, **[assumption]** ours, to validate. No customer quotes or market sizes are invented; where we have none, we say so.

## The problem

Appointment businesses of two to fifteen people (physio and Pilates studios, dental and allied-health practices, salons, tutors, trades that book jobs) lose money in three small, repeated phone calls nobody wants to make: confirming tomorrow's deposit, chasing an invoice that is weeks overdue, and settling a class or appointment the business itself cancelled. **[assumption]** These calls land on the owner or the one front-desk person, between clients, in the 15 minutes they have at lunch or after the last appointment.

- Surveys put the time small firms spend chasing late payments at about 1–2 hours a week on average, with a long tail far higher. GoCardless found 63% of Australian SMBs spend time pursuing payments, averaging 1.5 hours a week (~78 hours a year) among them. **[fact]** ([GoCardless, pursuing payments 2025](https://gocardless.com/en-nz/pursuing-payments-2025); [late payments benchmark](https://gocardless.com/guides/posts/late-payments-benchmark-small-business))
- In the UK, a QuickBooks survey of 2,008 owners found just under 10% spend 5–10 hours a week chasing invoices and 20% spend 1–4 hours. **[fact]** ([QuickBooks UK](https://quickbooks.intuit.com/uk/press/smbs-chase-late-payments/))
- Clinics already use deposits to protect slots: one Brisbane physio clinic takes a 50% deposit on initial bookings with a 48-hour window. **[fact]** ([POGO Physio](https://www.pogophysio.com.au/cancellation-policy/)) A single US clinic estimated a no-show costs it about $70 (2019, one clinic). **[fact, weak]**
- Calling is the part people avoid because it is awkward and has rules: in the US, AI-generated voices count as "artificial voice" under the TCPA, so these calls need consent ([Orrick on the FCC's Feb 2024 ruling](https://www.orrick.com/en/Insights/2024/02/Did-the-FCC-Really-Ban-AI-Generated-Voice-Calls-No-But-Restrictions-Apply)); collection calls are commonly held to 8am–9pm in the customer's own time zone (Reg F's presumption; confirm against 12 CFR 1006). **[fact, secondary sources]**

**Who has it:** owner-operator or practice manager; phone on the desk and in their pocket; uses a booking tool (Cliniko, Jane, Mindbody, Fresha) and an accounting tool, and PayPal or a card terminal to get paid. **[assumption]**

**The moment it hurts:** 12:40, between patients; three deposits for tomorrow unpaid, an invoice 31 days overdue from a customer who always asks for a discount, and a reformer class cancelled because the instructor is ill. Every call is a small negotiation they don't have time for, and every one has a rule they could break (calling at 7am in the customer's time zone, promising a discount they can't afford, refunding to an account the customer "just changed"). **[assumption]**

## How they solve it today

| Today | Cost | Gap |
|---|---|---|
| Owner or front desk calls by hand | 1–2 h/week typical, up to 5–10 h for some **[fact]** | Calls get skipped; discounts given on the spot; no record of consent or what was said |
| Booking-tool reminders and card-on-file deposits (Jane, Mindbody, Fresha) | Included in their subscription **[assumption]** | Reminds; does not negotiate a plan, settle a cancellation or chase an invoice |
| Email/SMS chasing software (Chaser, Upflow, Paidnice) | Paidnice from $69/month for 150 invoices **[fact]** ([Paidnice via search](https://hackceleration.com/labs/best/accounts-receivable-software-small-business)); Upflow tiers reported at $440–$880/month **[fact, third-party listing]**; Chaser entry prices vary by source **[fact, inconsistent]** | Built for B2B accounts receivable; email first; no voice; no deposit or class-cancel logic |
| AI voice platforms (Vapi, Retell) and collections voice agents (Monk, Peakflo) | Vapi $0.05/min platform fee plus model costs; Retell around $0.07–$0.18/min all-in **[fact, third-party estimates]** ([getmacha](https://www.getmacha.com/blog/retell-ai-vs-vapi), [11x](https://www.11x.ai/guides/vapi-pricing)); Monk added outbound voice collections in July 2026 **[fact]** ([runtimewire](https://runtimewire.com/article/monk-ai-voice-calls-accounts-receivable-agent)) | A toolkit to build an agent, or an enterprise AR product. Neither gives a 3-person studio rules it can read, holds for big moves, or proof of what was said |
| A collections agency | Typically a percentage of what is recovered **[assumption]** | Wrong tone for a regular customer you want to keep |

## Competitors and how we differ visually

| Product | Positioning | Visual style we avoid |
|---|---|---|
| [Chaser](https://www.chaserhq.com) | Automated invoice chasing for finance teams | Corporate blue SaaS, dashboard of charts |
| [Upflow](https://upflow.io) | B2B AR platform | Purple gradients, enterprise cards |
| Paidnice | Late-fee and reminder automation for Xero/QBO | Friendly pastel SaaS |
| [Retell AI](https://www.retellai.com/industry/debt-collection) / Vapi | Voice-agent infrastructure | Dark developer-console, neon |
| [Monk](https://runtimewire.com/article/monk-ai-voice-calls-accounts-receivable-agent) | AI AR for mid-market | Clean fintech white with a single accent |
| Jane / Mindbody / Fresha | Booking and payments for clinics and studios | Soft wellness pastels, photo-led |

None of them shows a call as the thing it is: a conversation with money moments in it, each with a rule behind it. That is our visual opening.

## The promise

**Callback makes the money calls you keep putting off, says only what your records say, and asks you before it does anything big.**

Three jobs it must make effortless:
1. **Know who to ring today and who not to, and why**, without the owner checking consent, time zones or call limits.
2. **Have the call and settle it**: a PayPal link, an invoice, a short plan, a refund or a credit, all within the owner's own words.
3. **Ask the owner only when it matters**: anything above their limits arrives as one tap (or a passkey above $200), with exactly what will move, to whom, and why.

Proof points a sceptical owner needs before trusting it with money: every amount on a call is from their records (the agent cannot produce one); the gate's decision for every move is visible; nothing over their limit moves without them; refunds only go back to the payment they came from; the customer can check a verify code so they know it is really the business; the whole transcript and trace is there to read; they can switch everything off with one switch.

## Who does what (the trust pattern the UI shows)

| Layer | Does | Never does |
|---|---|---|
| **AI (the voice)** | Chooses the next line and which offered option fits (a plan id, a discount step id, a callback slot) | Produce an amount, a percentage, a phone number or a PayPal id; read instructions from the customer's words |
| **Code (the rules)** | Computes every amount from the records; checks consent, do-not-call, local hours, attempts; runs the gate (kill switch, integer money, provenance, scam check, policy caps, live PayPal state, the owner's limits) | Act on anything the gate did not allow |
| **PayPal (the money)** | Holds and moves the money: orders, captures, invoices, subscriptions, refunds; is read back as the truth for what was paid | — |
| **The owner** | Sets the rules in plain words, approves holds, can stop everything | — |

Open questions to validate: will owners in physio/Pilates accept a voice agent calling their regulars (tone risk)? Is per-call or per-minute pricing preferred? How do Australian (Spam Act, Do Not Call Register) and UK rules differ from the US rules above for first-party calls? None of these is answered by the research here.
