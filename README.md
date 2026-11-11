# Callback

The voice agent that makes a small business's money calls: confirm tomorrow's deposit, chase an overdue invoice, settle a cancelled class. It speaks inside the owner's rules; PayPal does the money; every amount comes from the records, never from the conversation. Roadmap Part E.4.

## For judges: try it in 60 seconds

**Live:** https://pph-callback.onrender.com · **Start here:** https://pph-callback.onrender.com/judge

**Accounts.** None to type. The first button you press on `/judge` builds your own private copy of the demo studio and signs you in as its owner. No PayPal login is needed for any path: payments come from a saved sandbox wallet. A separate sandbox buyer for PayPal's own checkout page is not set up yet (the owner creates it; `/judge` prints it once `JUDGE_BUYER_EMAIL` is set). A QR code on `/judge` opens the same copy on your phone.

**Three things to look at** (each is a path on `/judge`; every step opens the exact screen with the text typed, and ticks itself when the server records it):

1. **Take the call yourself** (about 3 minutes, no PayPal login). Start Priya's deposit call, haggle, agree, then pay from the saved wallet on her own page. The model talks; code checks the amount against the record and your limits; PayPal's sandbox makes the order and capture.
2. **Watch it refuse.** Ask the agent who it won't call (its tool calls stream into a rail beside the answer), open a call that the rules blocked, and check the 10 Nov "we've moved banks, pay our new PayPal" message, which is now held.
3. **Approve a held move.** A $360 charge is over the $300 limit and waits for you with what, who, why and how to undo it.

**What is live and what is simulated.** `/judge` builds this table from the server's configuration on every request. On 11 Nov it said: live are PayPal Orders, the saved wallet, Invoicing, Billing plans and Subscriptions, refunds, verified webhooks, PayPal's MCP server (read tools only), the call and policy model (`gpt-6.1-sol`), the Decisions scam check (`gpt-6-luna`), live browser voice and Telegram approvals. Simulated and labelled are calls and texts to the demo customers (Twilio is set up but rings only allowlisted numbers), WhatsApp, web push, the seeded samples and each copy's clock.

**Pages with no sign-in:** `/proof` (every evaluation case), `/ai` (the last model calls), `/paypal` (each PayPal API and a live id), `/who-can-move-money`, `/accessibility`, `/agents` (MCP with a copy-paste command).

**Against the judging criteria.**

| Criterion | Where to see it |
|---|---|
| Technical | One gate for every money move (`src/guard/dryrun.ts`); the model's schema has no amount field; an Ask agent that uses Callback's own MCP server and PayPal's, with read tools only (`src/agent/ask.ts`); calibrated Decisions thresholds (`src/ai/thresholds.json`); 122 unit and flow tests, 12 browser journeys |
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
cp .env.example .env        # add PAYPAL_CLIENT_ID / SECRET (sandbox) and optionally OPENAI_API_KEY, Twilio, Telegram, WhatsApp, VAPID
npm run seed -- --pin       # Brightside Physio & Pilates, 8 customers, clock set to this weekday 11:00 Sydney; prints the owner key
npm run dev                 # http://localhost:3500
```
Sign in with the owner key (or press **Reset and seed** on `/demo`). Without PayPal credentials every page works and money moves fail honestly. Without an OpenAI key calls do not start and policy reading shows an error with a retry button; nothing written by rules is presented as AI (the rules brain runs only in tests and offline evals, `AI_PROVIDER=rules`). The deployed server (`RENDER=true` or `NODE_ENV=production`) refuses to start without the OpenAI key, `AI_PROVIDER=openai`, the PayPal credentials and `SESSION_SECRET`. Without Twilio the simulator carries the call. Without channel tokens every message is recorded as *simulated* on `/ops/channels`.

Other scripts: `npm test` (122 tests: structural, core, flows through the gate, journey with route coverage, foundation routes incl. MCP, private workspaces, honest AI failure), `npm run e2e` (Playwright journeys), `npm run typecheck`, `npm run sandbox:check` (credentials, scopes, webhook), `npm run eval:personas`, `npm run eval:adversarial`, `npm run cli -- plan|calls|start|say|trace`.

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
| Telegram / WhatsApp approvals, web push | tokens / VAPID | simulated, visible on `/ops/channels` |

Webhooks to register when keys arrive: `/webhooks/paypal`, `/webhooks/telegram`, `/webhooks/whatsapp` (verify token `WHATSAPP_VERIFY_TOKEN`), `/webhooks/sms`, `/webhooks/voice/{twiml,gather,status}/:callId`, `/webhooks/voice/events`.

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
- **Owner impersonation by message.** An inbound Telegram, WhatsApp, SMS or simulator message that claims to be the owner and asks to change payout or bank details is refused, audited (`safety.owner_impersonation`) and listed on `/safety`. Payout details change only in the signed-in settings.
- **Scam text model in the browser** (`public/safety/`, 23 MB int8 ONNX, fine-tuned MiniLM) scores a pasted message on the owner's device at `/safety`. Advisory; its score never reaches the gate. **Payment-risk model** (`public/safety/risk_lgbm.json`): monotone LightGBM, **trained on synthetic data**, a ranking signal shown with the rule reasons.

Tests: `test/safety.test.ts`; the model's measured results are on `/safety/model-card`.

## Accessibility (9 Nov 2026)

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
