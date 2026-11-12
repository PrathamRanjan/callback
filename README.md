# Callback

The voice agent that makes a small business's money calls: confirm tomorrow's deposit, chase an overdue invoice, settle a cancelled class. It speaks inside the owner's rules; PayPal does the money; every amount comes from the records, never from the conversation. Roadmap Part E.4.

## For judges: try it in 60 seconds

**Live:** https://pph-callback.onrender.com · **Start here:** https://pph-callback.onrender.com/judge

**Accounts.** None to type. The first button you press on `/judge` builds your own private copy of the demo studio and signs you in as its owner. No PayPal login is needed for any path: payments come from a saved sandbox wallet. A separate sandbox buyer for PayPal's own checkout page is not set up yet (the owner creates it; `/judge` prints it once `JUDGE_BUYER_EMAIL` is set). A QR code on `/judge` opens the same copy on your phone.

**Three things to look at** (each is a path on `/judge`; every step opens the exact screen with the text typed, and ticks itself when the server records it):

1. **Take the call yourself** (about 3 minutes, no PayPal login). Start Priya's deposit call, haggle, agree, then pay from the saved wallet on her own page. The model talks; code checks the amount against the record and your limits; PayPal's sandbox makes the order and capture.
2. **Watch it refuse.** Ask the agent who it won't call (its tool calls stream into a rail beside the answer), open a call that the rules blocked, and check the 10 Nov "we've moved banks, pay our new PayPal" message, which is now held.
3. **Approve a held move.** A $360 charge is over the $300 limit and waits for you with what, who, why and how to undo it.

**What is live and what is simulated.** Live: PayPal Orders, the saved wallet, Invoicing, Billing plans and Subscriptions, refunds, verified webhooks, PayPal's MCP server (read tools only), the call and policy model (`gpt-6.1-sol`), the Decisions scam check (`gpt-6-luna`), live voice in the browser, Call my phone (US/Canada, UK, Australia, Singapore, India), Telegram approvals and web push. Simulated, and labelled on the screens where they appear: calls and texts to the made-up demo customers (their numbers aren't real), the seeded samples and each copy's clock. WhatsApp was removed on 13 Nov because it was never connected to a real account. The live/simulated table that used to sit on `/judge` was removed the same day; the labels stay on each screen.

**Pages with no sign-in:** `/proof` (every evaluation case), `/ai` (the last model calls), `/paypal` (each PayPal API and a live id), `/who-can-move-money`, `/accessibility`, `/agents` (MCP with a copy-paste command).

**Against the judging criteria.**

| Criterion | Where to see it |
|---|---|
| Technical | One gate for every money move (`src/guard/dryrun.ts`); the model's schema has no amount field; an Ask agent that uses Callback's own MCP server and PayPal's, with read tools only (`src/agent/ask.ts`); calibrated Decisions thresholds (`src/ai/thresholds.json`); 123 unit and flow tests, 12 browser journeys |
| Design | The three-lane call score (voice, rules, money on one time line); the judge page; phone layouts checked at 375 px |
| Impact | Small studios lose money to awkward calls they put off; Callback makes them inside consent, calling hours and the owner's limits, and the customer's page carries a verify code against impersonators |
| Innovation | Code, not the model, decides money; four scam readers where green needs all of them; every AI step is visible (trace rail, `/ai`, `/proof` with failures listed) |

The source repository is private for now; making it public is the owner's decision.

## What it does
- **Plans the calls** from the records and PayPal state: deposits unpaid before tomorrow's appointment, invoices past the policy's grace, classes cancelled. Each candidate passes **consent, do-not-call and local calling hours** (08:00–21:00 floor in the customer's time zone, narrowed by the owner's policy, attempts per day, cooldown) in code before anything rings. Refusals are shown with the reason.
- **Makes the call** three ways with one brain and one gate: the in-app simulator (type as the customer or play one of 60 scripted personas), a real phone call through Twilio (turn-based Say + Gather speech, signature-verified webhooks), or live voice in the browser through OpenAI Realtime over WebRTC (every function call comes back to the server and through the gate).
- **Moves money only through PayPal, only through the gate**: a pay link (Orders v2, captured when the customer approves), an invoice (Invoicing v2), an instalment plan (Catalog product → Billing plan → Subscription with a fixed cycle count), a discount step, a class refund (Payments v2) or an account credit. The brain picks an option id; code computed every number. The dry-run gate checks kill switches, integer money, provenance (an amount that appears only in speech is denied), the policy's caps, live PayPal state, and the owner's autonomy limits. Anything above the limits is **held**, the agent says so on the call, and the owner approves by tap, Telegram/WhatsApp button, or passkey countersign over the exact payload hash.
- **Takes the policy in plain words** and compiles it to enforceable rules (clamped so no policy can exceed the statutory window or disable consent), says what it could not express, refuses what it must (calling without consent, threats, card details), and **backtests** it over 90 days of by-hand calls: run / wait / deny, money collected alone, hours saved. **Earned autonomy** suggests limits only from the owner's own approvals and never past a decline.
- **Proves it**: every call is a trace (each line, each tool, each gate decision, each PayPal request id); a hash-chained audit log; 60 persona evals (rules brain vs model brain vs oracle, dollars committed vs a naive agent, zero breaches); 25 adversarial attacks; an evidence page that reports only numbers the build produced itself.

## Run it
```bash
npm install
cp .env.example .env        # add PAYPAL_CLIENT_ID / SECRET (sandbox) and optionally OPENAI_API_KEY, Twilio, Telegram, VAPID
npm run seed -- --pin       # Brightside Physio & Pilates, 8 customers, clock set to this weekday 11:00 Sydney; prints the owner key
npm run dev                 # http://localhost:3500
```
Sign in with the owner key (or press **Reset and seed** on `/demo`). Without PayPal credentials every page works and money moves fail honestly. Without an OpenAI key calls do not start and policy reading shows an error with a retry button; nothing written by rules is presented as AI (the rules brain runs only in tests and offline evals, `AI_PROVIDER=rules`). The deployed server (`RENDER=true` or `NODE_ENV=production`) refuses to start without the OpenAI key, `AI_PROVIDER=openai`, the PayPal credentials and `SESSION_SECRET`. Without Twilio the simulator carries the call. Without channel tokens every message is recorded as *simulated* on `/ops/channels`.

Other scripts: `npm test` (123 tests: structural, core, flows through the gate, journey with route coverage, foundation routes incl. MCP, private workspaces, honest AI failure), `npm run e2e` (Playwright journeys), `npm run typecheck`, `npm run sandbox:check` (credentials, scopes, webhook), `npm run eval:personas`, `npm run eval:adversarial`, `npm run cli -- plan|calls|start|say|trace`.

## Pages
Signed in: `/today` plan and refusals · `/ask` the agent with its tool rail · `/calls`, `/calls/:id` transcript, options, trace, simulator, live voice · `/customers/:id` consent record · `/approvals` holds, passkey, limits, kill switches, audit chain · `/money` links, invoices, plans, refunds, read-back · `/rules` compile, backtest, earned autonomy · `/safety` scam check · `/messages` · `/evidence` evals and traces · `/trace/:id` · `/demo`. No sign-in: `/judge`, `/proof`, `/ai`, `/paypal`, `/who-can-move-money`, `/accessibility`, `/agents` · customer `/c/:token` (pay, check a message, callback, stop) · `/llms.txt`, `/skill.md`, MCP at `/mcp` (owner) and `/c/:token/mcp` (customer).

## Integrations and what is real
| Piece | Real when | Otherwise |
|---|---|---|
| Saved demo wallet (vault id, no PayPal login) | `PAYPAL_DEMO_VAULT_TOKEN` | the button is hidden; PayPal's own page still works |
| PayPal Orders, Invoicing v2, Catalog/Billing/Subscriptions, Payments refunds, Transaction Search, Balances, webhook verification | `PAYPAL_CLIENT_ID`/`SECRET` (sandbox) | honest failure; tests use an in-memory fake |
| Turn-based brain and policy reader (`gpt-6.1-sol`, backup `gpt-6-sol`) | `OPENAI_API_KEY` | calls don't start; policy reading shows an error and a retry button (the rules brain is a test and offline-eval arm only) |
| Live voice (WebRTC) | `OPENAI_API_KEY` | hidden; simulator shown |
| Phone calls and SMS | `TWILIO_*` | simulator; SMS mirrored to the customer page |
| Telegram approvals, web push | tokens / VAPID | simulated, visible on `/ops/channels` |

Webhooks to register when keys arrive: `/webhooks/paypal`, `/webhooks/telegram`, `/webhooks/sms`, `/webhooks/voice/{twiml,gather,status}/:callId`, `/webhooks/voice/events`.

## Walkthrough (Wave 1 text, kept for reference)

1. Open https://pph-callback.onrender.com/try and press **Be the owner**. You get your own private copy of the demo studio, already filled in: 11 customers, three sample calls marked **Sample**, three payments already made from the demo's saved sandbox PayPal wallet (the banner counts them as PayPal confirms them), and one $360 charge held for your approval because it is over the $300 limit. Nobody else sees your copy, and it is deleted after 48 hours without a visit. The banner has a link that opens the same copy on your phone.
2. **Take a call yourself.** On Today, open Priya's deposit call, start it, and type as the customer, for example "How do I know you're really the studio? And knock it down to forty." The reply comes from `gpt-6.1-sol` (named on the call page). It points you to the verify code on your account page, refuses the discount because your rules allow none, and keeps the amount from the records.
3. **Pay without a PayPal login.** Open any customer's page (Customers → a customer → their link) and press **Pay … as the demo customer**. It pays from the saved sandbox wallet, then shows the real PayPal order and capture ids it read back. **Pay on PayPal's own page** is still there if you want to sign in as a sandbox buyer.
4. **Watch it refuse.** Today lists who it will not call and why (no consent, outside their local hours, do-not-call). Needs you has the held $360 charge with what, who, why and how to undo it.
5. **If the AI fails**, a call does not start (or stops with a fixed line that says so), and the Rules page says "I couldn't read that with the AI model" with a Try again button. Nothing written by rules is shown as AI.

Real: PayPal sandbox (orders, captures, invoices, subscriptions, refunds, webhooks), the OpenAI models, the database. Simulated and labelled: calls to the demo customers' numbers and texts to them, and the studio clock (11:00 Sydney on today's weekday). Reset (banner) rebuilds only your copy.

## Folder
`src/core` consent, time, options · `src/ai` provider, grounding, brain · `src/guard` gate, policy, backtest, kill, audit, provenance, passkey · `src/services` planner, calls, money, seed · `src/voice` telephony, realtime, tools · `src/channels` · `src/eval` personas, adversarial, store · `src/mcp` · `src/web` · `test/` · `scripts/` · `eval/` reports · `docs/foundation.md`.

PayPal sandbox only. No real money moves. MIT.

## Scam and fraud protection (9 Nov 2026)

The people at risk on a collections call are the customer, who cannot tell our agent from a scammer pretending to be the business, and the owner, who can be impersonated. Three layers, strictest wins, none can approve a payment (`SAFETY_ACCESSIBILITY_SPEC.md` §4, Callback row of §6):

- **Verify code.** Every call opens with a four-digit code (`verifyCode` in `src/safety/index.ts`, stored in the call state) that the customer's status page `/c/<token>` also shows, so they can check it is really us.
- **The agent never asks for secrets.** Every line the agent is about to say is scanned (`agentLineUnsafe`); a line asking for a one-time code, password or card number, or moving payment off PayPal, is replaced with a correction, counted as a breach and recorded as a `safety.agent_line` trace step.
- **Rules in the gate** (`src/guard/dryrun.ts`, step 2b): a refund the customer asks to send to a different account or card is held (`safety.refund_to_other_account`); scam tactics in the customer's words are cautions in the trace; protected mode holds every agent refund and discount for the owner.
- **Owner impersonation by message.** An inbound Telegram, SMS or simulator message that claims to be the owner and asks to change payout or bank details is refused, audited (`safety.owner_impersonation`) and listed on `/safety`. Payout details change only in the signed-in settings.
- **Scam text model in the browser** (`public/safety/`, 23 MB int8 ONNX, fine-tuned MiniLM) scores a pasted message on the owner's device at `/safety`. Advisory; its score never reaches the gate. **Payment-risk model** (`public/safety/risk_lgbm.json`): monotone LightGBM, **trained on synthetic data**, a ranking signal shown with the rule reasons.

Tests: `test/safety.test.ts`; the model's measured results are on `/safety/model-card`.

## Accessibility (9 Nov 2026)

> Superseded on 11 Nov by the Wave 5 section below: the checks that now run on every build (axe on 46 page views, reflow at 320 px and 200%, keyboard only, reduced motion), voice input on Ask, and /accessibility showing the dated results.

`public/a11y.js` and `public/a11y.css` on every page, including the customer's: a **Display and help** button with text size, high contrast, Atkinson Hyperlegible, read-aloud, voice input (on-device where the browser supports it), plain words, bigger targets, more time and no motion. A first-visit card offers the same choices on owner pages. The profile stays in this browser's `localStorage`; typing and buttons always work without it.

## Wave 1 (11 Nov 2026): what changed, and the live checks

Built from `MASTER_IMPROVEMENT_SPEC.md` Part C, Wave 1.

- **A1 private workspaces.** Each visitor gets their own database schema (`cbws_<id>`), seeded through the same code paths the app uses (`src/services/workspaces.ts`). The gate makes the held $360 charge, and the saved wallet makes the three sample payments. Starts are limited to 5 per address per hour and 40 live copies; the spec says 300, but 40 is the cap because the free database is 1 GB and shared by 8 apps. The longest-idle copy is recycled when the cap is reached, and copies expire after 48 idle hours. PayPal webhooks (by `custom_id` `<workspace>:<record>` or the stored id) and Telegram chats are answered inside the copy that made them. The shared showcase studio feeds the landing preview, nobody signs into it, and it is rebuilt at boot and every 24 hours. Resetting it needs `CB_ADMIN_KEY`.
- **A2.1 saved demo wallet.** `POST /c/:token/wallet/:id` pays with the vault id from `PAYPAL_DEMO_VAULT_TOKEN` through the gate. The order is read back from PayPal (`GET`) before anything is marked paid.
- **A4 hosting.** `/healthz` runs `SELECT 1` and reports the commit. The demo clock is 11:00 Sydney on today's weekday, with no fixed dates. A call with no new turn for 10 minutes ends as `abandoned`. In the demo, the attempts rule counts only finished calls (spec C3).
- **A11 and A5.** The models are `gpt-6.1-sol` (backup `gpt-6-sol`) and `gpt-6-luna`. Requests use a 4,000-token cap and low reasoning effort. Broken JSON gets one repair attempt. If a guard rejects a line (an invented amount, or an option that was not offered), the backup model is asked once. After that the call stops with a fixed line and the outcome `ai_failed`. The rules brain runs only in tests and offline evals. The deployed server will not start without its keys. Cost figures use list prices from secondary sources (OpenAI's own pricing page was not read).
- **Part B fixes.** C1: one session request per page load (was three). C3: the attempts rule above. C4: no pinned date. C6: the pricing block with no prices is removed. C7: the session survives a switch to a phone user agent. The tour no longer starts on its own or pulls you back to Today. Calls, Money and Proof filters are buttons, not broken ARIA tabs. Messages, Money and the other two-column pages fit a phone. The Messages page now opens on the owner's conversation. Seeded calls carry a Sample chip. The agent-line check no longer replaces "check the verify code on your page".

**Live checks** (`node scripts/live-acceptance.mjs`, against the deployed commit f10e8db):

| Item | Check | Result | Detail |
|---|---|---|---|
| A4 | /healthz answers and checks the database | Pass | HTTP 200, db postgres, 70 ms, commit f10e8db, first answer after 173 ms |
| A1 | two visitors each get a private studio, signed in as the owner | Pass | A 302→/today, B 302→/today; private true/true |
| A1 | the two studios share no records | Pass | 11 and 11 customers, 0 shared ids |
| A4 | the demo clock is a current weekday, not a pinned date | Pass | studio clock 2026-11-11T00:00:00.000Z |
| A1 | the seed holds one move for the owner through the real gate | Pass | 1 pending: charge |
| A2.1 | seed payments made from the saved wallet and confirmed by PayPal | Pass | 3 of 3 payments confirmed by PayPal |
| A2.1 | customer page pays from the saved wallet, no login; real sandbox ids read back | Pass | order 57N59585E2232752D, capture 9KG70495AH630922B; item now paid |
| A1 | the payment shows only in the payer's studio | Pass | the other studio's deposit is open |
| A5.1 | a call turn runs on the model named on screen | Pass | brain model; OpenAI gpt-6.1-sol for call turns and reading your policy (backup gpt-6-sol); place 302, say 303, 21165 ms |
| B2 | haggling line: points to the verify code, no discount, no invented amount | Pass | You can check the verification code on your account page, or call the studio using a number you trust. I’m sorry, there’s no discount available on your account. The balance is $150.00. |
| A5.4 | policy text is read by the model, numbers by code | Pass | source model, ai_failed false, max discount 10% |
| A1 | strangers cannot arm faults or reset the showcase | Pass | fault → /demo?err=Only the owner can make PayPal fail on purpose.; reset → /demo?err=Only the owner of a demo can reset it, from inside that demo. The shar |

Run 2026-11-10T17:27:09.304Z against https://pph-callback.onrender.com.

**Checked by hand in a browser on the live site (11 Nov, commit f10e8db):**

| Check | Result | Detail |
|---|---|---|
| Customer page, phone width: **Pay as the demo customer** | Pass | Lena's $180 invoice paid; order 7G91325308942590F, capture 062871670Y002840J shown on the page, read back from PayPal |
| PayPal's own webhooks land in the right copy | Pass | 4 verified `PAYMENT.CAPTURE.COMPLETED` events in that copy: its 3 seed payments and the browser payment |
| C7: still signed in after switching to a phone user agent | Pass | reloaded /today with an Android user agent; stayed on /today |
| C1: Today on a warm site | Pass | Today's figures drawn about 0.2 to 1 s after navigation; 1 session request (was 12 s in the review) |
| axe WCAG 2.2 AA on Calls, Money, Proof, Messages, Rules | Pass | no violations, light theme at phone width and dark theme at desktop width |
| No sideways scroll at 375 px | Pass | Today, Calls, Money, Proof, Messages (also in the e2e suite for every owner page) |
| C6: landing has no pricing block | Pass | no "Pricing" heading |

**Failed or not verified:**

- **Cold start: not verified.** The service was warm during every check. The free Render plan sleeps after idle minutes, so the first visit after a quiet spell is slow. The fix is an always-on instance, which the owner buys in Render's dashboard. No keep-warm ping was added: a ping would spend the free plan's instance hours, which the account's other apps also use.
- **A call turn took 21 s on the second run** (6.5 s on the first): an opening line and one reply, each a `gpt-6.1-sol` call with low reasoning effort. Not yet measured per call. Voice moves to `gpt-live-1` in Wave 3.
- **Telegram inside a private copy: not verified live.** The routing is unit-tested; no Telegram message was sent from a private copy.
- **The honest AI failure states** (no key, failing model) are verified in tests (`test/ai-honest.test.ts`) and locally. They were not provoked on the live site, because that would mean removing the live key.
- **Evaluation fixtures still use fixed times** (`src/eval/*`, `scripts/eval-adversarial.ts`). They test calling-hours rules and are never shown as live data.

## Wave 2 (11 Nov 2026): what changed, and the live checks

Built from `MASTER_IMPROVEMENT_SPEC.md` Part C, Wave 2 (items 6 to 9).

- **A5.2 Decisions client and thresholds.** `src/ai/decisions.ts` calls `POST /v1/decisions` (`gpt-6-luna`) with yes/no questions, retries up to three times, and audits every call. A refusal or missing answer counts as "not decided". The per-question thresholds are in `src/ai/thresholds.json`. `npm run calibrate` writes them from a 65-message hand-written set (`eval/decisions/`, 34 tuning and 31 held out; a miss costs five times a false hold). They are copied into the `decision_thresholds` table at boot. Three questions (gift cards, overpay-and-refund, too-good offers) have too few examples and keep the default thresholds.
- **A6 scam check v2.** Four readers, and the strictest one wins: the rules (widened so that every one of the 31 phrasings of the 10 Nov message fires), the Decisions check, code that pulls out each place to pay and compares it with the business's record, and the on-device model in the browser. Green shows only when every reader ran and found nothing, and nothing names a place to pay. A reader that did not run says "not run". A message that names a place to pay is amber at best: "This asks you to pay somewhere. Confirm it by phone on a number you already had." The customer's own page has the same check (`POST /c/:token/check`, no sign-in). A6.4 (retraining in guard-lab) is a cross-app job and is not done here.
- **A5.3 Ask.** `/ask` runs a tool loop (`src/ai/loop.ts`, at most 8 steps or 45 s, `gpt-6.1-sol`) over three groups of tools:
  - the read-only tools of Callback's own MCP server, reached in-process;
  - PayPal's hosted MCP server over SSE, limited in code to 11 read tools, because PayPal's server marks none of its 46 tools read-only;
  - `propose_*` tools that only write a proposal row for the owner.

  Every step is an `agent_trace` row, streamed to the rail by server-sent events. Each answer sentence cites the facts it rests on, and code removes any sentence whose dollar amount is in none of them. Email addresses are masked in the rail. Without a model, Ask answers 503; it never falls back to rules.
- **A3 judge page and no-sign-in pages.** `/judge` has three paths. Each step ticks itself from `workspaces.checklist` when the server records the matching event (`call_placed`, `ai_turn`, `pay_link_sent`, `paid_from_wallet`, `asked_the_agent`, `opened_blocked_call`, `checked_message`, `viewed_hold`, `approval_decided`, `opened_money`). The seed's own calls and holds tick nothing. The page also has a QR code for the phone and the live-versus-simulated table, both built at request time. `/proof`, `/ai`, `/paypal`, `/who-can-move-money`, `/accessibility` and `/agents` need no sign-in. The in-app evidence page moved to `/evidence`. Tours start only from a button, run on one page, never navigate, and end on any page change. The old cross-page judge tour is gone.
- **A5.6 and B2 regression set.** `npm run eval:ai` (`src/eval/regression.ts`) writes `eval/results/ai-eval.json`, and `/proof` lists every case in it:
  - **Call turns:** the seven off-script lines from the 10 Nov review (haggling, "stop calling", a lost job, "already paid", "send it to my husband's email", the wrong person, a different amount), each checked by code.
  - **Policy reading:** four cases.
  - **Scam check:** the Decisions held-out half.

  The run is by hand, not nightly: a nightly run on the free 512 MB instance risks the live site. The first run failed one call turn ("already paid") and two policy readings (instalments, refund limit). The prompt and the parser were fixed, and the committed run is 7/7, 4/4 and 30/31. The one scam-check miss is a false hold on "my husband will pay with his own PayPal".
- **Fixes found on the way.** The service worker now clones a response before caching it. Tables that scroll sideways can take keyboard focus (axe `scrollable-region-focusable`). The Ask presets wrap on a phone. The PayPal page's MCP row had a wrong column name, which was hidden as "none yet"; a failed read now says "Couldn't read this just now" and is logged.

**Live checks** (`node scripts/live-acceptance-w2.mjs`, against the deployed commit e07b7a3):

| Item | Check | Result | Detail |
|---|---|---|---|
| A4 | /healthz answers and names the deployed commit | Pass | HTTP 200, commit e07b7a3 |
| A3.1 | a stranger sees three paths, the live-versus-simulated table and the public pages | Pass | Take the call yourself (4 steps, 3 min); Watch it refuse (3 steps, 2 min); Approve a held move (3 steps, 2 min); 15 live rows, 5 simulated |
| A3.1 | after the first tap: a QR code for the phone and every step points at this demo's own screens | Pass | join link present; 10 of 10 steps have a screen |
| A3.1 | nothing is ticked before the visitor acts (the seed ticks nothing) | Pass | 0 ticks |
| A3.1 | path 1 (take the call yourself, no PayPal login): every step ticked itself | Pass | 4/4 ticked (call_placed, ai_turn, pay_link_sent, paid_from_wallet); place 302, say 303/302, wallet → /c/cbt_w6t3wpdmx24_dD5KrU0XtsDx7sS4umg-XU0HU07nhfG2?ok=Paid%20%2460.00%20from%20the%20demo; 21 s by script |
| B2 | the haggling turn: no invented discount, the agreed turn: a real sandbox order | Pass | agent said: "I’m sorry money’s tight. There isn’t a discount available on the account, but we can arrange a callback. Would that help?" then "Of course. I’ll send the payment link to the contact details on file. Thank you."; PayPal order 2H8892570N015084L |
| A6 | the 10 Nov message is held by every server reader, with the place to pay named | Pass | level hold; rules hold, AI hold (gpt-6-luna, 1751 ms), places to pay hold: accounts.brightside@outlook.com |
| A6 | a polite message that names a place to pay never gets green | Pass | level hold, names a place true, all clear allowed false |
| A6 | a genuine reminder: every server reader ran and found nothing | Pass | level clear, AI clear, all clear allowed true |
| A6 | the customer's own page holds it too (no sign-in) | Pass | level hold |
| A5.3 | the judge's Ask question: the rail shows at least two tool calls and a cited answer | Pass | 5 tool calls (get_plan, list_customers, consent_record, consent_record, consent_record); 4 sentences, 0 removed by code; 15 s |
| A5.3 | a PayPal question goes through PayPal's MCP server, read tools only | Pass | 7 tool calls, 3 on PayPal's server (paypal_list_transactions, paypal_get_order, paypal_get_order) |
| A3.1 | paths 2 and 3 ticked themselves too | Pass | Take the call yourself: 4/4; Watch it refuse: 3/3; Approve a held move: 3/3; approve → /ops/guard?ok=Approved.%20PayPal%20link%20for%20%24360.00%20sent%20to%20Ivy%20Pa |
| A5.6 | /proof lists every case with today's run date and the model ids | Pass | run 2026-11-11T01:12:32.172Z; Call turns: the 10 Nov off-script lines 7/7 on gpt-6.1-sol (backup gpt-6-sol); Policy reading 4/4 on gpt-6.1-sol; Scam check (Decisions, held-out half) 30/31 on gpt-6-luna, answers recorded 2026-11-11; 4 not-measured notes |
| A3.2 | /paypal: each API with a live sandbox id where one exists | Pass | OAuth 2.0 client credentials: none yet; Orders v2: 413455591J593762H; Orders v2: 4K62508939228462U; Invoicing v2: none yet; Catalog products, Billing plans, Subscriptions: none yet; Payments v2: none yet; Webhooks: 79019982JV370180D; PayPal MCP server: paypal_list_transactions |
| A3.2 | /ai: the last model calls with model, latency and cost | Pass | 0 showcase calls listed |
| A3.2 | /who-can-move-money: limits read from the studio's settings | Pass | charge 300, refund 100, countersign 200; 8 roles |
| A3.2 | every no-sign-in page loads without a session | Pass | /judge 200, /proof 200, /ai 200, /paypal 200, /who-can-move-money 200, /accessibility 200, /agents 200 |

Run 2026-11-11T01:51:38.295Z against https://pph-callback.onrender.com (commit e07b7a3).

**Checked in a browser on the live site (11 Nov, commit e07b7a3):**

| Check | Result | Detail |
|---|---|---|
| axe-core 4.10 (WCAG 2.2 AA) on /judge, /proof, /ai, /paypal, /who-can-move-money, /accessibility, /agents | Pass | no violations at 375 px light or 1280 px dark |
| No sideways scroll at 375 px on the no-sign-in pages | Fixed after a fail | /judge scrolled sideways once a demo existed: the long phone link widened the grid. Fixed in the next commit and covered by the e2e suite. The other six pages passed |
| A tour never starts from a URL | Pass | /today?tour=judge showed no tour |
| A tour starts from the button and ends on a page change | Pass | "This is your switchboard" showed; after opening Money, no tour remained |

**Failed or not verified:**

- **The three-minute path on a real phone, by a person who has never seen the app: not verified.** The script finished path 1 in 21 s, and it passed in a desktop browser. Nobody new has tried it, and it was not tried on a phone.
- **/paypal has no live id yet for Invoicing, Billing plans and Subscriptions, or refunds.** No demo on the live site has used those calls since the copies were made. A payment plan also needs the buyer to approve it on PayPal's own page, with a PayPal login.
- **/ai lists no showcase calls**, because nobody signs into the showcase studio. It shows other visitors' recent calls with their text hidden, and your own calls in full.
- **The eval is not nightly.** It was run by hand on 11 Nov and committed.
- **No judge sandbox buyer and a private repository.** Both are the owner's to do: create a second sandbox buyer (and set `JUDGE_BUYER_EMAIL`), and decide whether to make the repository public.
- **A6.4** (retraining the on-device model in guard-lab) is a cross-app job and is not done here.

## Leftovers from Waves 1 and 2 (11 Nov 2026, evening): what changed, and the live checks

These close the open items in the two sections above where code could close them. Commit 2cc3fd6.

- **/paypal now has a live sandbox id for every API.** Nothing in the app was missing: no demo had used invoices, plans or refunds yet. `scripts/live-paypal-coverage.mjs` does it in a fresh private demo, the way a visitor would:
  - on a call, Tom asks for a PayPal invoice;
  - on Lena's page, she splits her invoice into a plan. PayPal creates the product, the plan and the subscription, and waits for the buyer to approve on its own page;
  - on Tom's page, he takes a refund for the cancelled class. The seed paid that class from the saved wallet, so the refund goes back to a real capture.
  
  The OAuth row now shows when this server last got a token (never the token itself) instead of "No id".
- **A wrong line from the agent, found on the first live run.** The agent sent a real PayPal invoice but told Tom "I can't confirm it will be a PayPal invoice". The call model is now told what each tool really does. A new regression case, `asks_invoice`, checks it, and the call-turn set is now 8 cases.
- **The honest AI failure can be shown live (A11).** The owner of a private demo can press "Make the AI fail for 2 minutes" on the Demo page. For those two minutes every OpenAI request from that demo gets a 503 inside the server, before anything is sent to OpenAI. The live key is untouched and other demos are unaffected. Results: a call does not start ("nothing was said to the customer"), the scam check says its AI reader did not run and never shows green, and Ask says it could not answer. Nothing falls back to rules.
- **The nightly eval is ready but switched off.** `.github/workflows/ai-eval.yml` runs `eval:ai --fresh` on GitHub's machines, not on the 512 MB Render instance. The run asks the live models again, including the Decisions API for the 31 held-out messages; the committed thresholds are not re-tuned. It then commits `eval/results/ai-eval.json`, which redeploys the site. It stays off until the owner does two things: add `OPENAI_API_KEY` as a repository secret, and set the repository variable `AI_EVAL_NIGHTLY=true`. The result file records who ran it, so /proof says "nightly" only when the scheduled workflow wrote it. Today's committed run was by hand with `--fresh`: 8/8, 4/4 and 30/31 (the one miss is still the false hold on "my husband will pay with his own PayPal"). It was also run with only the OpenAI key set, to show the workflow needs nothing else.
- **Tests:** vitest 123/123; Playwright 12 passed, plus the screenshot capture, which is skipped by design.

**Live checks** (`node scripts/live-paypal-coverage.mjs`, against the deployed commit 2cc3fd6):

| Item | Check | Result | Detail |
|---|---|---|---|
| A2.1 | the new demo's seed payments are confirmed by PayPal | Pass | 3 of 3 payments confirmed by PayPal |
| A3.2 | refund of the cancelled class goes back to its PayPal capture | Pass | paid by PayPal true; Refund of $35.00 sent to the PayPal account you paid with. |
| A3.2 | a payment plan creates a real product, plan and subscription waiting for the buyer | Pass | 2 fortnightly payments of $90.00 → https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token= |
| A3.2 | a customer who asks for an invoice on a call gets a real PayPal invoice | Pass | call chase_invoice; agent: "Of course, Tom. PayPal will email an invoice with a pay button to the email address on file, giving you seven days to pa"; invoice INV2-JCL5-DEGG-Z5JC-9AVE |
| A3.2 | /paypal shows a live sandbox id for invoices, plans and refunds | Pass | OAuth: access token (not shown) (29 scopes); Invoicing: INV2-JCL5-DEGG-Z5JC-9AVE; Subscriptions: I-5VRC56YFRF2H; Refund: 7RY77690YT9492312 |
| A3.2 | /paypal: the OAuth row shows when this server last got a token (never the token) | Pass | access token (not shown) (29 scopes), 2026-11-11T13:51:44.904Z |
| A4 | call-turn model latency measured per call (no target: recorded) | Pass | 3 call turns; median 3749 ms, slowest 4747 ms, fastest 3560 ms |
| A11 | with the AI switched off, a call stops honestly: no rules stand-in, outcome ai_failed or not started | Pass | armed: The AI now fails in your demo only for 2 minutes. Place a ca; call planned, outcome none; place said: The AI model couldn't start this call, so nothing was said to the customer. Try again in a moment. |
| A11 | with the AI switched off, the scam check says its AI reader did not run and never shows green | Pass | AI reader not_run (the AI check didn't answer just now); all clear allowed false; not fully checked: the AI check didn't answer just now |
| A11 | with the AI switched off, Ask says it could not answer (no made-up answer) | Pass | POST 200; run failed; {"kind":"failed","message":"The AI couldn't finish this answer just now. Nothing was changed. Try ag |
| A11 | switched back on, the AI reader runs again | Pass | The AI is back on.; AI reader clear |

Run 2026-11-11T13:52:53.378Z against https://pph-callback.onrender.com (commit 2cc3fd6).

**Wave 2 checks re-run on 2cc3fd6:** all 18 passed (`node scripts/live-acceptance-w2.mjs`; the Wave 2 table above has the same 18 checks). Path 1 took 17 s by script. The 10 Nov message was held by all three server readers; the Decisions reader took 433 ms. The judge's Ask question used 5 tools, and the PayPal question made 3 calls on PayPal's MCP server. /proof shows the fresh run. /paypal now lists a live id in all 8 rows.

**What the earlier "not verified" items are now:**

| Earlier item | Now |
|---|---|
| /paypal had no id for invoices, plans and subscriptions, or refunds | **Fixed and verified live.** Real ids are in the table above. A plan stays "waiting for the buyer" until someone approves it with a PayPal buyer login, which has not been done. |
| The honest AI failure states, verified only in tests | **Verified live**, using the demo's own switch (four A11 rows above). |
| A call turn took 21 s | **Measured.** Each model call takes 3.6 to 4.7 s (median 3.7 s). The 17 to 21 s is the whole scripted path: an opening line, two replies, a real PayPal order and a wallet payment. |
| The eval is not nightly | **Ready, waiting on the owner:** the repository secret and variable described above. Until then it is run by hand. |
| Cold start | **Still not verified.** See below. |
| Telegram inside a private copy | **Still not verified.** Someone needs to message the bot from a Telegram account. |
| A person trying the three-minute path on a phone | **Still not verified.** It needs a person who has never seen the app. |
| A judge sandbox buyer; a public repository | **Still the owner's to do.** |

## Wave 3 live check (commit 846c6da, 11 Nov 2026, 14:50 UTC)

`node --env-file=.env scripts/live-voice-check.mjs <wavdir> https://pph-callback.onrender.com`. This uses real GPT-Live (gpt-live-1) and the PayPal sandbox. It plays recorded customer audio into the Twilio Media Streams test line. **18 of 19 passed.**

| Item | Check | Result | What happened |
|---|---|---|---|
| B2.1 | Live voice is on, on gpt-live-1, and the page says plainly why Call my phone is off | Pass | The operator has not chosen which countries it may dial |
| B2.1 | Call my phone refuses honestly while it is off | Pass | HTTP 403. Nothing rang |
| B2.1 | The test line needs the operator key, then returns a stream token that works once | Pass | HTTP 403 without the key, HTTP 200 with it |
| B2.1 | The agent greets with GPT-Live audio, and its first words say this is a demo call from an AI | Pass | 21.5 s of agent audio |
| B2.3 | Asked to hold the deposit, the agent texts a PayPal hold link (Orders intent AUTHORIZE) | Pass | Order 4LN0387714961441K |
| B2.3 | The spoken hold line is written by code, with the amount from the record | Pass | "…hold $150.00 for Deposit for 6-week reformer block…" |
| B2.2 | The stop request is decided on the transcript by GPT-Live's trigger, with its probability | Pass | asked_to_stop_calls 100% (gpt-6-luna) |
| B2.2 | Code ends the call as do-not-call and marks the customer | Pass | Outcome do_not_call, dnc true |
| B2.1 | The phone line closes when the call ends | Pass | Closed 11.6 s after the stop line |
| B2.1 | The customer's spoken lines are in the transcript, and every amount spoken was backed by a record | Pass | 0 corrections |
| B2.4 | The owner's screen followed the call live | Pass | 158 partial lines, 7 lines, 22 decision updates |
| B2.1 | A stream token that has been used is refused | **Fail on Render** | Timed out waiting for the close code. Locally the server closes with 1008 (19/19 on localhost). On Render the proxy seems not to pass the close frame on. Not yet looked into |
| B2.3 | Hold from the saved sandbox wallet, then Attended: charge (capture) | Pass | Authorization 5N333751PU103470K, capture 5AV10648RE036623R |
| B2.3 | Cancelled in time: release (void, read back VOIDED) | Pass | Authorization 6VW55467W2715152K |

**Cold start.** After 17 idle minutes the free plan took 22.3 s to return HTTP 200. Warm requests took 0.17 to 0.83 s.

**Not verified:**
- A real phone call. There is no owner number and no CB_CALL_MY_PHONE_COUNTRIES yet, and the Twilio trial can only dial verified numbers.
- A real browser microphone call over WebRTC. The routes are tested with a fake GPT-Live server.

**Not done (spec B2 items 5, 6, 7):** custom voice, a proof call on the landing page, and inbound calls. **Wave 5 for Callback** (A7 accessibility and voice on Ask, A12 render.yaml, nightly robot judge, quality gate) is not started.

### Wave 3 follow-up: the used-token refusal on Render (commit b90e368)

The one Wave 3 failure was that a used stream token's refusal never reached the caller on Render. The socket opened, but the close frame did not arrive. Render's edge seems to drop close frames: the end-of-call close also came through as 1006. The stream now sends a plain message first, `{"event":"closing","code":1008,"reason":"not allowed"}`, which Twilio ignores. Then it closes, and cuts the socket after two seconds if the close does not finish.

**Live voice check at b90e368: 19 of 19 passed.** The used token is refused with code 1008 and 0 audio frames are sent.

## Wave 5 (11 Nov 2026): accessibility, voice input on Ask, the Render blueprint, the robot judge

### A7 accessibility: what changed

- **`e2e/a11y.spec.ts`** runs with the browser tests and fails on what the spec forbids. Each check writes its own section, with the time it ran, to `eval/a11y.json`. **`/accessibility` shows that file**, check by check, with its dates. The landing page's first screen has the line "Works with a screen reader, at 200% text, and by voice", linked to /accessibility. /judge names accessibility as one of three things to look at.
- **Push-to-talk on Ask ("Talk instead").** A listen-only `gpt-live-1` session over WebRTC, from `POST /api/app/voice/dictate`. It is signed in only and limited to 30 a day per address. GPT-Live's transcript is typed into the box as you speak, and nothing is asked until you press Ask. The browser never plays the session's audio. There is no delegation, no tools and no sideband, so nothing acts on what is said. It stops after 60 s. Typing always works.
- **One polite live region** (`#cb-status-live`) announces payment and hold status changes. It covers Money (polled every 20 s) and the customer's own page, which now polls too, so a payment PayPal confirms while the page is open is said once.
- **Reflow fixes** at 320 px with the Largest text setting:
  - Both headers wrap.
  - The figure cards on Today, Money, Rules and Proof stack.
  - Long buttons on the customer page and /judge wrap.
  - Public page headings hyphenate.
  - The landing figure shrinks to fit.
  - The old results table on /accessibility is replaced by cards.
- **Display and help:** each switch is `aria-labelledby` its title and `aria-describedby` its description. The close button is named "Close display and help" and is 44 px.

### A7 checks on the live site (b90e368, 11 Nov 2026, 15:48–15:52 UTC)

`E2E_URL=https://pph-callback.onrender.com npx playwright test e2e/a11y.spec.ts`

| Check | Result | What happened |
|---|---|---|
| axe-core, WCAG 2.0/2.1/2.2 A and AA, on every page of every persona (a stranger, the owner, the front desk, a customer), light at 1280 px and dark at 375 px | Pass | 46 page views of 22 pages: 0 serious or critical issues, 0 minor or moderate |
| No sideways scroll at 320 px with Largest text, nor at 200% zoom (a 640 px window, the layout width 200% zoom gives on a 1280 px screen) | Pass | 24 checks on 12 pages, 0 overflowing. The first local run found 3 to 324 px of sideways scroll on every page at 320 px with Largest text; fixed as above |
| Nothing moves when the system asks for reduced motion | Pass | 0 running animations on /, /judge, /today and /calls |
| Keyboard only: from a fresh load of Today, open Needs you (approvals) in the sidebar and approve a held $420.00 move | Pass | 33 Tab presses and two Enters; every focused control showed a focus ring. The order is recorded in eval/a11y.json and shown on /accessibility |
| Display and help switches are announced with a name and a description | Pass | Stronger contrast, Easier-to-read letters, No movement and Bigger buttons all have descriptions |
| One polite live region for payment status | Pass | 1 region |
| Voice input on Ask: GPT-Live accepts the listen-only session, transcribes, and says nothing (`node --env-file=.env scripts/dictation-probe.mjs voice/l2.wav`; same session over WebSocket, fed a recorded question) | Pass | Transcript: "Can you just hold the deposit instead? So it's only charged if I attend". Agent words: none. GPT-Live still sent 115 frames of output audio with no words, which the browser does not play |

**A7 not verified:**
- No person has used a screen reader (VoiceOver, TalkBack or NVDA) on any of these pages. axe finds missing names and roles; it cannot say whether a page is pleasant to use.
- No testing with disabled users.
- No person has tried push-to-talk in a real browser with a microphone. Only the same session config was tested, over WebSocket.
- The spec's "plain words on the device" (Chrome's Rewriter or Prompt API) and the four-language string tables are **not done**.

### A12 the Render blueprint, the robot judge and the quality gate

- **`render.yaml`** is the full shape:
  - a web service, with health check `/healthz` and always-on `plan: starter`;
  - a background worker (`node dist/worker-main.js`, new);
  - four cron jobs: PayPal reconcile every 30 minutes, demo expiry hourly, today's plan at 07:00 Sydney, and the robot judge nightly. The first three run through `node dist/cron.js reconcile|expire|plan`, which is new;
  - managed Postgres;
  - preview environments per pull request;
  - an env group listing every variable, with secrets `sync: false` and nothing secret in the file.
- **What the blueprint checks showed:**
  - `render blueprints validate render.yaml` returns only `need_payment_info` on the 7 paid resources, and no schema errors.
  - Locally, `dist/cron.js` ran all three jobs (exit 0), refused an unknown job (exit 2), and `dist/worker-main.js` started, ticked and stopped on SIGTERM.
  - **The live demo does not use this file.** It is still the one free web service with the worker inline. Applying the blueprint creates paid services, which is the owner's purchase.
- **`.github/workflows/robot-judge.yml`** runs `scripts/live-acceptance-w2.mjs` against production. It wakes the free instance, then walks all three /judge paths as a visitor and fails if any step did not tick itself or any public page is down:
  - take the call: a simulated call with two AI turns, a sandbox order, and a payment from the saved wallet;
  - watch it refuse: Ask, the blocked call, and the scam checks;
  - approve a held move.

  It needs no secret. **The nightly run is off until the owner sets the repository variable `ROBOT_JUDGE_NIGHTLY=true`.** "Run workflow" works at any time.
- **Robot judge on the live site at b90e368, run from this machine: 18 of 18 passed.** All three paths ticked every step.
- **PayPal coverage at b90e368: 10 of 11.** The failure was a real bug that the robot judge's run exposed: the scam check keeps answers for 10 minutes, so with the AI switched off it still showed an AI answer from two minutes earlier as "clear". It now skips kept answers while the demo's AI switch is on. A test was added; it fails without the fix. **At 7acc868, robot judge then PayPal coverage, in that order: 18/18 and 11/11.**

### Found when the robot judge first ran on GitHub: the per-address limits were shared by every visitor (fixed in 038c84b)

The first two GitHub runs were refused a demo with "This address has started 5 demos in the last hour". `GET /api/ops/request-ip` (operator key only, added for this) showed why:
- On Render the request chain is visitor → Cloudflare → Render's proxy → the app. `req.ip`, with `trust proxy` 1, was **Render's internal proxy (10.x), the same for every visitor**.
- So the 5-demos-an-hour limit, the live voice limits (10 a day per address, 5 phone calls) and the scam-check limit were shared by all visitors. On a busy judging day, the sixth judge in an hour could not start a demo.
- `clientIp()` now takes Cloudflare's `CF-Connecting-IP` / `True-Client-IP` on Render. Cloudflare sets these itself, overwriting anything the visitor sends. Off Render it uses `req.ip`, and a made-up `X-Forwarded-For` changes nothing (test/client-ip.test.ts).
- **After the fix:** the server sees the visitor's address, a demo starts from this machine again, and **the robot judge on GitHub's machines passed 18 of 18** (run 43056288904, commit 038c84b), every step of all three paths ticked.

### Quality gate (spec A12) for Callback, as of 11 Nov 2026

| # | Gate | State |
|---|---|---|
| 1 | Unit and end-to-end tests pass, including workspace isolation and axe | **Met** locally: 136/136 unit (workspaces.test.ts is the isolation test) and 17 browser tests including the five accessibility checks. 1 test (screenshot capture) is skipped on purpose |
| 2 | The off-script regression set (Part B) passes on the live site | **Met** for what this machine can run: Wave 2 checks 18/18, PayPal coverage 11/11, live voice 19/19 |
| 3 | The robot judge completes every /judge path on production | **Met**: 18/18 on GitHub's machines (run 43056288904) and 18/18 from this machine. The nightly schedule waits for the owner's `ROBOT_JUDGE_NIGHTLY=true` variable |
| 4 | A stranger completes one path in under three minutes on a phone | **Not met.** It needs a person; the script takes about 30 s |
| 5 | /proof, /paypal, /ai and /accessibility show today's date and real data | **Met today** (robot judge checks /proof's run date; /accessibility shows 11 Nov). /proof stays current only if the nightly AI eval runs, which needs the owner's `OPENAI_API_KEY` secret and `AI_EVAL_NIGHTLY` variable |
| 6 | The README's judge section, live-versus-simulated table and criteria mapping are current | **Met** for what is in this README. Owner items are listed in docs/STATE_OF_THE_UNION.md |

## Languages, hands-free "Look and Say", connect your assistant (12 Nov 2026)

These are extras. The core flow (plan → call → gate → PayPal → proof) is unchanged, and its tests run first in English.

**In short, in four languages** (the three non-English summaries are machine-assisted):

- **English.** Callback makes a small business's payment calls. The AI talks; code and the owner's rules decide every amount; PayPal moves the money. The app, the calls and the texts work in English, Hindi, Indonesian and Brazilian Portuguese. It can be used hands-free with eyes, head or voice.
- **हिन्दी.** Callback छोटे व्यवसायों के लिए भुगतान से जुड़ी कॉल करता है। बात AI करता है; हर रकम कोड और मालिक के नियम तय करते हैं; पैसा PayPal से जाता है। ऐप, कॉल और मैसेज अंग्रेज़ी, हिन्दी, इंडोनेशियाई और ब्राज़ीलियाई पुर्तगाली में चलते हैं, और इसे आँखों, सिर या आवाज़ से बिना हाथ लगाए चलाया जा सकता है।
- **Bahasa Indonesia.** Callback melakukan panggilan soal pembayaran untuk usaha kecil. AI yang berbicara; setiap jumlah ditentukan oleh kode dan aturan pemilik; uang dipindahkan lewat PayPal. Aplikasi, panggilan, dan pesan tersedia dalam bahasa Inggris, Hindi, Indonesia, dan Portugis Brasil, dan bisa dipakai tanpa tangan dengan mata, kepala, atau suara.
- **Português (Brasil).** O Callback faz as ligações de cobrança de pequenos negócios. A IA conversa; o código e as regras do dono decidem cada valor; o PayPal movimenta o dinheiro. O app, as ligações e as mensagens funcionam em inglês, hindi, indonésio e português do Brasil, e dá para usar sem as mãos, com os olhos, a cabeça ou a voz.

### In four languages

- **English · हिन्दी · Bahasa Indonesia · Português (Brasil).** The picker sits on the first screen and in every header. `?lang=hi-IN` works on any link. The choice is remembered on the device and, once signed in, for the user.
- **How it is built:**
  - all 1,416 interface strings go through `t()`, with a glossary for terms that must stay fixed (PayPal, deposit, hold, do-not-call);
  - the translations were made by machine (`npm run i18n:translate`, `gpt-6.1-sol`); the customer's payment page and every translated transcript carry a **Machine-translated** label;
  - `npm test` starts with `scripts/i18n-check.mjs`, which fails on a missing key, a dropped `{placeholder}`, or English typed straight into a screen or into a prop people see or hear (confirm prompts, labels, placeholders, titles, aria-labels).
- **Money** is always US dollars, formatted for the language: `US$ 1.540,68` in Portuguese, `$1,890.00` in Hindi. Code formats the amount; translation never touches the number.
- **The AI:** Ask answers in the chosen language, and the call agent speaks the caller's language. Policy reading and the scam check still answer in English. Messages to a customer go out in the customer's language. PayPal's pages open in the matching locale (pt-BR, id-ID; Hindi uses en-IN, because PayPal has no Hindi checkout).
- **Calls in four languages.** The greeting uses the language on the customer's record. When the caller answers in another of the four languages, code detects it from their words and keeps it on the call. The agent then carries on in that language.
  - Transcripts are stored exactly as spoken.
  - The owner can press **Translate** to get a machine translation, labelled as such, next to the original.
- **Screenshots:** `docs/screenshots/lang/` has the landing page, Today, a call and a customer in each language (taken by `e2e/languages.spec.ts`, which walks one full flow per language and fails on any untranslated string).

### Hands-free: Look and Say

Turn it on with the eye button in the header or **Alt+Shift+H**. A camera light shows while it is on.

- **The camera stays on the device.** MediaPipe's face landmarker runs in the browser (wasm served from this site). No image or landmark is sent anywhere.
- **Pointing:**
  - Calibrate with nine dots. Each dot is checked against a model fitted without it (leave-one-out), and the page shows your accuracy in pixels. The calibration is saved on this device.
  - The gaze point is smoothed and snaps to the nearest button, with votes that decay. Drift is corrected as you use it. If eye tracking is poor, use head mode.
- **Pressing:** dwell (look and wait), say "click", or wink.
  - A blink freezes the pointer.
  - Moving the real mouse hands control straight back.
  - Esc, the word "stop" in any of the four languages, or looking away stops everything.
- **Voice:** a wake word ("Callback, …") or push-to-talk.
  - Noise and echo gates: the app's own speech and playing audio are not heard as commands.
  - "This one" means the button you are looking at.
  - Spoken requests go to the app's own tools, at most 10 steps.
- **Money and messages need a confirm card, enforced in code.** Anything that moves money, places or ends a call, sends a message, or changes consent shows a card first, and Confirm needs twice the normal dwell. Before pressing, the page reads the button's current state. The PayPal checkout is handed back to your hands, with a message saying so.
- **Fallbacks:** with no camera, a refused camera, or offline before the face model has loaded, it switches to keyboard scan. A highlight steps through the buttons and Space presses one. The bar says why.
- **`/accessibility#hands-free`** has:
  - a 30-second recording (simulated gaze, captioned);
  - a live simulated-gaze demo;
  - the measured numbers.

Simulated benchmark (the page's own snapping and dwell code on synthetic gaze; 300 looks at random targets among 48 buttons of 120 × 44 px on 1280 × 800, 0.7 s dwell, seed 7):

| Gaze jitter | Right button | Wrong button | Nothing pressed | Mean time |
|---|---|---|---|---|
| 20 px | 100% | 0% | 0% | 1.07 s |
| 40 px | 100% | 0% | 0% | 1.08 s |
| 60 px | 100% | 0% | 0% | 1.15 s |
| 80 px | 99.7% | 0% | 0.3% | 1.48 s |
| 120 px | 76% | 0% | 24% | 3.03 s |

This tests the snapping and dwell code, not a camera or a real person's eyes.

### Connect your assistant (`/agents`)

The demo owner sees:
- their workspace's MCP key (hidden until **Show**);
- a config to paste into any MCP client;
- a **Try it from here** button that makes one real read-only MCP call;
- a panel listing every MCP request to the workspace as it arrives (tool, arguments cut to 300 characters, status, time).

The key works only on that demo workspace and a demo reset issues a new one. Push-to-talk (dictation) is on the call simulator and the Messages box.

### Checks before merge (12 Nov 2026, branch `lang-handsfree`)

| Check | Result |
|---|---|
| `npm test` (language check, then unit and flow tests) | 156/156; 1,416 keys translated in all three languages |
| `npm run e2e` (all browser journeys, including the core English flows, axe, reflow at 320 px, one full flow per language, hands-free on simulated gaze and on real MediaPipe with a fake camera) | 26 passed, 1 skipped on purpose (screenshot capture) |
| Live calls in Hindi, Indonesian and Portuguese (`scripts/live-voice-lang.mjs`): a robot caller speaks lines recorded with macOS voices over the phone-bridge socket; GPT-Live, the gate and the PayPal sandbox are real | 18/18 on a local server with the production settings: language detected and kept on the call, agent switched language, PayPal link texted in the caller's language, English translation for the owner, original unchanged, call ended |
| PayPal's own page in the caller's language | A Portuguese caller's sandbox order opened PayPal checkout in Portuguese ("Pague com PayPal") in a browser set to US English. Nothing was typed on PayPal |

**Found and fixed by these checks:**
- A caller who switched language mid-call got the pay-link text and PayPal's page in their *record's* language (English). The call's detected language now reaches the money step. `test/flows.test.ts` covers it, and the test fails without the fix.
- Payment and consent confirm prompts and the Approve button were still in English. The language check now fails on English in any prop people see or hear.

**Found after merge, on the live site, and fixed (core flow, 12 Nov evening):**
- **A call could ring someone about money already paid.** A new demo pays three sample items from the saved wallet just after it opens, but the call plan was written first. One planned call was for a deposit already paid, and the agent rang to say $0.00 was owed. This had been the case since Wave 1. Now:
  - the planner retires a planned call whose item is paid or has money held on it, with the reason;
  - starting a call on a paid item is refused in code;
  - the seed skips calls on the items it is paying and re-plans afterwards (eec08e6, c5a2137).
- **Code-written lines on a call were English-only.** When a tool step failed on a Portuguese call, code said "I couldn't do that just now". Every line code says on a call now exists in all four languages: held, refused, failed, PayPal error, dispute, safety correction and the next-step question (138cdbc).
- **/agents briefly said "not a demo workspace"** while the key was loading. It now says Loading (c589e85).
- **The first CI runs on GitHub failed:** the language check found the root TypeScript 7, which has no compiler API. CI now installs the web packages first and passes (dbd77a5).

### Live checks on https://pph-callback.onrender.com (12 Nov 2026)

| Check | Commit | Result |
|---|---|---|
| Wave 1 acceptance (`scripts/live-acceptance.mjs`): private demos, seed payments, wallet payment, model call turn, policy reading | c5a2137 | 12/12 |
| Wave 2 acceptance (`scripts/live-acceptance-w2.mjs`): all three /judge paths tick themselves, scam check, Ask with PayPal's MCP, public pages | c5a2137 | 17/18. The one failure: `/proof` still shows the 11 Nov eval run. It refreshes only when the nightly AI eval runs, which waits for the owner's `OPENAI_API_KEY` secret and `AI_EVAL_NIGHTLY` variable |
| Languages, /agents and hands-free (`scripts/live-smoke-lang-hf.mjs`, one demo) | c5a2137 | 5/5: `?lang=pt-BR`; Today in Portuguese with 0 untranslated strings; demo key masked, and a real MCP call shown in the log; confirm card on simulated gaze, with Cancel leaving the call unstarted; the 30 s recording served |
| Calls in Hindi and Indonesian (`scripts/live-voice-lang.mjs`) | 138cdbc | 12/12 |
| Calls in Portuguese, and the English voice check (`scripts/live-voice-check.mjs`) | c5a2137 code on a local server with the production settings | Portuguese 6/6, English 19/19. On the live site, this address hit the demo's own limit of 10 live voice calls a day. Earlier today the English check passed 19/19 live on b2d0bb2 |
| GitHub CI (language check, then unit tests) | c5a2137 | passing |

### Not verified

- **No real person has used hands-free.** Gaze was tested with simulated input and with real MediaPipe on a fake camera, but not with real eyes, a real webcam, or a real microphone.
- Wink detection and head mode have unit tests only.
- The translations were checked by script (placeholders, coverage, layout at 320 px), not by native speakers.
