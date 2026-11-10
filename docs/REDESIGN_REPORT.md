# Callback: redesign and judging report (10 Nov 2026)

## What it is and who it's for

Callback phones a small bookings business's customers about money and settles each call through PayPal:
- deposits due before an appointment,
- invoices past due,
- refunds or credits for classes the business cancelled.

It is built for owner-run studios, clinics and salons that have no one to chase payments (see `docs/PRODUCT_BRIEF.md` for sourced facts and labelled assumptions). The trust model is three lanes: **the AI proposes, code decides, PayPal moves.**

## What changed

- **Audit fixes** (commit `dbe4f91`, details in `docs/AUDIT.md`):
  - owner-created customers and charges, so the app no longer depends on seed data;
  - real PayPal refunds for cancelled bookings;
  - approvals that actually carry out after the call ends;
  - no invented amounts or canned reasons;
  - the demo never texts or calls an unlisted real number;
  - approvals scoped to the business.
- **New front end** (`web/`, built to `dist/client`, served by the same Express app):
  - React 18, TypeScript, Vite 6, Tailwind v4, shadcn/ui (new-york, restyled), radix-ui, lucide, sonner, Driver.js for tours. All MIT.
  - The old server-rendered pages still answer `?classic=1` and non-browser clients, so every existing route, test and MCP tool is unchanged.
- **Design direction "Switchboard"** (`docs/DESIGN_BRIEF.md`; chosen 23 vs 17 vs 13 on the brief's scorecard):
  - Each customer is a lamp: ready, on the line, needs you, settled, not calling. A lamp is never colour alone; a word always sits next to it.
  - Signature element: the **three-lane call score** (Voice / Rules / Money on one time axis).
  - Archivo (wide) for display, IBM Plex Sans for text, Plex Mono for PayPal ids, tabular figures for money.
  - Warm paper light theme and a near-black dark theme, both WCAG AA.
- **Every screen opens with three lines:** what happened, what needs you, what happens next.
- **Approvals** show what moves, to whom, why it stopped, how to undo it, and what declining does. Passkey countersign is supported for big moves.
- **Tours:**
  - first-run per persona (owner 8 steps, front desk 6), shown once and skippable;
  - Judge Mode, 12 steps across pages, including the live PayPal sandbox step and the customer's own page. Start it with `?tour=judge`, `/judge`, the landing button, or the ribbon. It survives reloads and navigation.
- **Demo ribbon** says what is live (PayPal sandbox, AI model) and what is simulated (calls and texts to demo numbers, the clock), and offers a one-tap reset.
- **Accessibility panel** ("Display and help"): text size, stronger contrast, Atkinson Hyperlegible, no movement, bigger buttons, read aloud. The settings stay on the device.

Screenshots: `docs/screenshots/{landing,today,call,approvals,money,portal}-{375,768,1440}-{light,dark}.png` (36 files).

## Results

| Check | Result |
|---|---|
| Typecheck (server and web) | Clean |
| Unit and route tests (vitest) | 79/79 |
| Browser journeys (Playwright, `npm run e2e`) | 9/9 |
| Full production build from clean (`npm run build`, the Render command) | OK |
| Lighthouse mobile, landing (local) | Performance 90 · Accessibility 100 · Best practices 100 · SEO 100 (LCP 3.1 s, TBT 20 ms, CLS 0) |
| Lighthouse mobile, Today (local, signed in) | 91 · 100 · 100 · 100 (LCP 2.9 s, CLS 0.006) |
| Live sandbox journey, fresh data (local) | Order `7M809337FB9838239` $60.00 → approved by the sandbox buyer → capture `9HR66219YR4887257` $60.00, read back as paid |
| Evals | Adversarial 25/25 blocked. Personas: rules 60/60, model 56/60 (traps 22/24), oracle 60/60 |

The nine browser journeys:
1. landing at 360 px with no sideways scroll;
2. owner deposit call that creates a PayPal sandbox order;
3. a $420 move held, then approved and carried out;
4. a customer and an invoice created from scratch;
5. front desk blocked from Money;
6. the customer's own page;
7. the full Judge tour;
8. display settings persist;
9. phone layout: bottom nav, More sheet, no tap target under 40 px.

### Failures and limits, stated plainly

- **Lighthouse performance** sits right at the line (90/91), measured locally. Render's free tier sleeps when idle and will score lower on a cold start. The first load is still 127 kB of gzipped JavaScript.
- **Buyer activity page:** the capture was confirmed through PayPal's own API (the read-back). PayPal's account pages ask for a separate login from checkout, so the capture was not also matched by eye on the buyer's Activity page.
- **Not exercised in this pass:** live voice (Realtime needs a microphone), Telegram and web push.
- **Screenshot runs** use the rules brain so they are repeatable. The live site uses the AI model.

## Live QC

Filled in after the deploy below.

## Scores (strict, out of 10)

| Criterion | Before | After | Evidence | Gap |
|---|---|---|---|---|
| Technological implementation | 7 | 8 | Real sandbox money paths with idempotency, a gate with replayable approvals, model guardrails, in-browser ONNX scam model, MCP, hash-chained audit, e2e and unit tests | Realtime voice and Telegram unverified this pass; the model brain is slower and less accurate than the rules brain (56/60, about 10 s per turn) |
| Design | 5 | 8 | Distinct switchboard identity, signature three-lane score, mobile-first with bottom nav, AA both themes, Lighthouse a11y 100 | Dense on the call page at tablet width; no motion design beyond the live lamp |
| Potential impact | 6 | 6.5 | Real pain for owner-run businesses; can now be used without seed data | No user validation; tone risk of AI calling regulars untested; pricing hypothetical |
| Innovation / idea | 7 | 7.5 | Voice agent + rules gate + PayPal with "AI proposes, code decides, PayPal moves" made visible | Voice collections agents exist (enterprise); the novelty is the small-business trust layer, not the call itself |
| Presentation | 5 | 8 | Landing with live preview, 3-minute Judge tour, honest demo ribbon, persona picker | No recorded video yet; tour depends on a warm Render instance |

## Tracks

| Track | Verdict | Reason | Single best change |
|---|---|---|---|
| Overall 1st | Long shot | Strong and honest, but a judge must try it to feel it; there are no users | Record a 90-second video of the Judge tour with a live sandbox payment |
| Overall 2nd / 3rd | Realistic contender | Depth of the money safety layer plus a finished UI is rare at a hackathon | Same video, plus pin the live URL warm before judging |
| Most Creative | Long shot | The three-lane score is distinctive; the core idea (AI calls about payments) is familiar | Make the score replayable like a timeline scrubber |
| Most Impactful | Long shot | Impact is argued, not shown | One real owner trying it on their own bookings, quoted with permission |
| Best Demo Delivery | Realistic contender | Judge tour plus a live sandbox payment in under 3 minutes | Rehearse the tour on the live site on a phone |
| Best Use of PayPal + AI | **Realistic contender** | Orders, Invoicing, Subscriptions, Refunds, Balances, webhooks and idempotency, driven by an AI agent behind a deterministic gate | Show a refund and an instalment plan in the Judge tour, not only a pay link |
| Best Use of Agentic Commerce | Realistic contender | An agent that negotiates within rules, holds for approval, and exposes the same tools over MCP | Demo an outside agent using the MCP tools through the same gate |
| AG Grid 1st/2nd/3rd | Not eligible | AG Grid is not used | — |
| APIMatic | Not eligible | No APIMatic SDK or portal used | — |
| Bryntum | Not eligible | Key declared in config, never used | — |
| Channel3 | Not eligible | Key declared in config, never used | — |
| Render 1st/2nd/3rd | Long shot | Deployed on Render (web service plus Postgres schema), auto-deploys from main | A `render.yaml` blueprint and a paid instance so it doesn't sleep |

Against a typical hackathon field, Callback's edge is the money safety layer and honest labelling. Its weakness is that nothing proves demand.

## Top 3 remaining changes

1. Record the Judge tour on the live site, with a sandbox payment, refund and plan, as a short video.
2. Keep the Render service warm (or upgrade it) during judging, and set `CB_LIVE_CONTACT_ALLOWLIST` to the presenter's own phone so the "Ring their phone" path can be shown live.
3. Add a refund and an instalment plan to the Judge tour, and verify live voice and Telegram once on the deployed site.

## Not done

- **`CB_LIVE_CONTACT_ALLOWLIST`** was not set on Render. It decides which real number the demo may call or text, and that's the owner's call to make.
- **Live voice and Telegram** were not tested.
- **No Magic UI or Aceternity components** were used (see the design brief for why).
