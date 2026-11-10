# Callback audit (10 Nov 2026)

What was checked, what was fake or hard-coded, what was fixed, and what is still simulated. Fixes landed in commit `dbe4f91` (server) and the `redesign` branch (front end and the fixes found while rebuilding it).

## Integration matrix

| Integration | State | Evidence |
|---|---|---|
| PayPal Orders v2: create and capture | **Live (sandbox)** | Local run with fresh data: a simulated call created order `7M809337FB9838239` for $60.00. The sandbox buyer approved it, and the read-back worker captured it as `9HR66219YR4887257` ($60.00, status paid). Earlier, on the live Render site, a model-brain call created order `2AT79497TW892323P` ($60.00); it was not paid, so it was never captured. |
| PayPal Invoicing v2 | Live (sandbox) credentials and scope | `npm run sandbox:check`: invoicing scope ✓. The automated tests use the fake client. |
| PayPal Catalog, Billing plans, Subscriptions | Live (sandbox) credentials and scope | sandbox:check: subscriptions scope ✓. |
| PayPal Payments refunds | Live (sandbox) when the booking was paid through PayPal | Before the fix, the seeded class was "paid" outside PayPal, so a refund could never reach PayPal (see fixes). |
| PayPal Balances | Live (sandbox) | Read on the Money page: SGD 19,049.93, USD 0.00 at the last read. |
| PayPal webhooks | Signature verification coded; sandbox simulate works | Creating the webhook is skipped locally (no public URL). On Render it uses `PAYPAL_WEBHOOK_ID`. |
| Idempotency (`PayPal-Request-Id`) | Real | Deterministic per action. Demo fault injection (503 / lost response) shows that a retry never double-charges. |
| OpenAI Responses (gpt-5.5) call brain | Live | Strict output schema with no money fields. Persona eval: model 56/60 clean, traps 22/24, p50 about 10 s per turn, $0.41 for the run. Rules brain 60/60, oracle 60/60. |
| OpenAI Realtime (voice, WebRTC) | Configured; ported to the new UI | Same protocol as before (ephemeral secret, data channel, tool calls through `/calls/:id/tool`). Not exercised in this audit: it needs a microphone. |
| Twilio SMS and voice | Configured (full account) | Demo numbers are now fictional, and only allow-listed numbers are contacted for real (see fixes). |
| Telegram (shared bot), web push | Configured | Connect flow ported. Not exercised end to end in this audit. |
| Scam text model (ONNX, in browser) | Live | Scam guard page, demo message: model 87% in 47 ms, rules "hold" with 6 reasons, risk model 41% (synthetic training data). |
| Adversarial gate | Live | 25/25 attacks blocked. |
| Hash-chained audit log | Live | Verified on the Needs you page. |

## Hard-coding and fakes found, and what was done

| # | Finding | Severity | Fix |
|---|---|---|---|
| 1 | No way to add a customer or a charge: the product only worked on seed data | P0 | `POST /customers`, `POST /customers/:id/charges`, `POST /obligations/:id/cancel` (validated, then re-plans calls), plus forms in the new UI. Covered by an e2e test that creates a customer and an invoice from scratch. |
| 2 | The cancelled-class line always said "the instructor is unwell" | P0 | The reason is now a note on the booking, given by the owner when cancelling; the agent reads it from the record. |
| 3 | The seeded cancelled class was marked paid outside PayPal, so "refund to PayPal" could never happen | P0 | Cancelling a paid booking copies its real `capture_id`, so the refund goes through PayPal Payments. |
| 4 | Approving a held move after the call ended did nothing, despite saying "it carries it out on its next turn" | P0 | `carryOutApproved` runs the exact approved payload through the gate (same hash) and says plainly if the amounts changed. |
| 5 | The model could say a dollar figure that wasn't on the record | P0 | The `inventedAmounts` guard: any `$` or `%` not in the balance or the offered options hands the turn to the rules brain, and the reason is logged. |
| 6 | Model errors silently fell back to the rules brain | P1 | Fallback reason recorded in the trace. |
| 7 | The demo sent texts to real-looking numbers (one live SMS attempt to an Australian mobile, status failed) | P0 | Seed numbers moved to fictional ranges. `CB_LIVE_CONTACT_ALLOWLIST` decides who is contacted for real in demo mode; everyone else is simulated. |
| 8 | Approval lists were not scoped to the business | P1 | Scoped by `payload.businessId`. |
| 9 | Judge copy said Dev was in Los Angeles; the data says London | P2 | Copy fixed. |
| 10 | Call traces had blank step numbers (`seq` vs `step`) | P2 | Fixed in the API. |
| 11 | The web build wrote to `dist/web` and deleted the compiled server there | P0 (would have broken the deploy) | The front end now builds to `dist/client`. |
| 12 | The server cached `index.html` in memory, so a rebuild without a restart served a blank page | P1 | Read on each page load (under 2 kB). |
| 13 | No gzip: the first load was 478 kB of JavaScript | P1 | `compression` middleware (skips MCP and webhooks), plus code-splitting. Lighthouse mobile: landing 90, Today 91. |

## Still hard-coded or simulated (on purpose, labelled)

- **Clock.** The demo clock is pinned to 4 Mar 2026, 13:00 studio time, so calls are inside calling hours whenever a judge looks. The ribbon says so, and Demo controls has a real-time reset.
- **Phone and SMS** to demo numbers are simulated. Messages show on the customer's page and in Messages.
- **Planner thresholds.** The deposit window (36 h) and invoice grace (7 days) are constants, not policy fields.
- **Currency.** The `$` sign and USD amounts are hard-coded; the sandbox merchant holds SGD as well.
- **Risk model** was trained on synthetic data; the UI says so wherever its score appears.
- **Pricing** on the landing page is labelled "Illustrative only".

## Open risks

- **Trace pages** are readable without signing in when demo mode is on.
- **Twilio webhooks** accept unsigned requests only when no token or secret is configured in demo mode.
- **Render free tier** sleeps when idle, so the first load after a sleep is slow; the Lighthouse numbers above are from a local run.
