# Callback

The voice agent that makes a small business's money calls: confirm tomorrow's deposit, chase an overdue invoice, settle a cancelled class. It speaks inside the owner's rules; PayPal does the money; every amount comes from the records, never from the conversation. Roadmap Part E.4.

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
npm run seed -- --pin       # Brightside Physio & Pilates, 8 customers, clock pinned to Wed 13:00 Sydney; prints the owner key
npm run dev                 # http://localhost:3500
```
Sign in with the owner key (or press **Reset and seed** on `/demo`). Without PayPal credentials every page works and money moves fail honestly. Without an OpenAI key the deterministic rules brain takes every turn and the UI says so. Without Twilio the simulator carries the call. Without channel tokens every message is recorded as *simulated* on `/ops/channels`.

Other scripts: `npm test` (57 tests: structural, core, flows through the gate, journey with route coverage, foundation routes incl. MCP), `npm run typecheck`, `npm run sandbox:check` (credentials, scopes, webhook), `npm run eval:personas`, `npm run eval:adversarial`, `npm run cli -- plan|calls|start|say|trace`.

## Pages
`/today` plan and refusals · `/calls`, `/calls/:id` transcript, options, trace, simulator, live voice · `/customers/:id` consent record · `/policy` compile, backtest, earned autonomy · `/ops/guard` holds, passkey, limits, kill switches, audit chain · `/ops/money` links, invoices, plans, refunds, read-back, negative paths, webhooks · `/ops/traces`, `/trace/:id` · `/ops/eval` explorer with CSV and Markdown · `/ops/channels` · `/ops/evidence` · `/judge` five beats · `/demo` · customer `/c/:token` (pay, callback, stop) · `/llms.txt`, `/skill.md`, MCP at `/mcp` (owner) and `/c/:token/mcp` (customer).

## Integrations and what is real
| Piece | Real when | Otherwise |
|---|---|---|
| PayPal Orders, Invoicing v2, Catalog/Billing/Subscriptions, Payments refunds, Transaction Search, Balances, webhook verification | `PAYPAL_CLIENT_ID`/`SECRET` (sandbox) | honest failure; tests use an in-memory fake |
| Turn-based brain and policy compiler | `OPENAI_API_KEY` | deterministic rules brain (same gate, same evals) |
| Live voice (WebRTC) | `OPENAI_API_KEY` | hidden; simulator shown |
| Phone calls and SMS | `TWILIO_*` | simulator; SMS mirrored to the customer page |
| Telegram / WhatsApp approvals, web push | tokens / VAPID | simulated, visible on `/ops/channels` |

Webhooks to register when keys arrive: `/webhooks/paypal`, `/webhooks/telegram`, `/webhooks/whatsapp` (verify token `WHATSAPP_VERIFY_TOKEN`), `/webhooks/sms`, `/webhooks/voice/{twiml,gather,status}/:callId`, `/webhooks/voice/events`.

## Folder
`src/core` consent, time, options · `src/ai` provider, grounding, brain · `src/guard` gate, policy, backtest, kill, audit, provenance, passkey · `src/services` planner, calls, money, seed · `src/voice` telephony, realtime, tools · `src/channels` · `src/eval` personas, adversarial, store · `src/mcp` · `src/web` · `test/` · `scripts/` · `eval/` reports · `docs/foundation.md`.

PayPal sandbox only. No real money moves. MIT.
