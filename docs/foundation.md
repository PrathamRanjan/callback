# Callback: foundation and flagship (roadmap Part B and E.4), 9 November 2026

Where each roadmap item lives in this codebase, and what is real against the PayPal sandbox versus modelled or simulated. Nothing here is shared with the other seven apps.

## E.4 Callback (the flagship)
- `src/services/planner.ts`: candidates from obligations (deposit due < 36 h, invoice > 7 days overdue, cancelled class) with a consent/hours verdict each; `planCalls` writes planned or blocked calls with the reason, idempotently, and skips obligations with a scheduled callback.
- `src/core/consent.ts`: `mayCall` (consent record, revocation, do-not-call, policy purposes, statutory 08:00–21:00 floor in the customer's tz narrowed by the owner's hours and days, attempts/day, cooldown, next window). Called by the planner and again by `startCall`.
- `src/core/plans.ts`: instalment options, discount steps, callback slots: every number the agent may offer, computed from the records and the rules.
- `src/ai/agent.ts`: one brain contract (say, tool, option_id, outcome), two brains: `rulesBrain` (deterministic) and `decide` (OpenAI strict schema; falls back to rules; drops option ids that do not exist). No money, percentage, phone or id field exists in the schema.
- `src/services/calls.ts`: `startCall` (consent + kill re-check, opens the run), `customerSays` (speech → provenance "speech" → quarantine → brain → one tool through the money services; holds and denials become spoken lines), `endCall`, `deriveOutcome`.
- `src/services/money.ts`: `sendPayLink` (Orders v2), `createInvoice` (Invoicing v2), `applyDiscount`, `createPlan` (product → plan → subscription), `settleCancelledClass` (refund via Payments v2 or credit), `readBack` (PayPal is the truth; captures approved orders under the gate). Every write is behind `gate(` with a deterministic PayPal-Request-Id; failed/unknown local rows are retried with the same id.
- Voice: `src/voice/telephony.ts` (Twilio Calls API, TwiML Say + Gather, X-Twilio-Signature verification, status callbacks, `voice_events`), `src/voice/realtime.ts` (client secret mint, tools and instructions with option ids only), `src/voice/tools.ts` + `public/call.js` (WebRTC in the browser; function calls routed to `/calls/:id/tool`).
- Pages: `src/web/owner.ts` (home, login, Today, customers, policy), `src/web/calls.ts` (calls, call page, simulator, realtime, voice webhooks), `src/web/customer.ts` (`/c/:token`), `src/web/demo.ts`.

## B.1 Model path and grounding
`src/ai/provider.ts` (OpenAI Responses API, strict schemas, read/classify/vision tiers, primary → fallback → replay → rules, `assertSafeSchema`, `ai_calls` audit, cost estimate). `src/ai/grounding.ts` (`quarantine`, `spanExists`).

## B.2 Traces
`src/trace.ts`: `agent_runs`/`agent_trace`, `Run.step/timed/end`, `resumeRun` (a call's run spans many HTTP turns). Pages `/trace/:id` (owner, or customer by token for their own calls), `/ops/traces`, JSON `/api/v1/runs`.

## B.3 Agent surfaces
`src/mcp/tools.ts`: owner server (14 tools incl. `get_plan`, `place_call`, `draft_policy`, `decide_approval`) and customer server (`my_account`, `get_pay_link`, `callback_slots`, `stop_calls`), both stateless Streamable HTTP via `src/mcp/http.ts`. `skill/SKILL.md` at `/skill.md`, `/llms.txt`, `scripts/callback-cli.ts`.

## B.4 Adversarial harness
`src/eval/adversarial.ts`: 25 attacks (speech injection, forged owner authority, over-cap discount/plan, unsourced or fractional amounts, autonomy, kill switches, consent/hours/tz/attempts/revocation, forbidden policy text). Runs the real gate in dry-run; no PayPal write is reachable. `npm run eval:adversarial` → `eval/adversarial.md` (25/25 blocked).

## B.5 Measured
`src/eval/personas.ts`: 60 scripted customers (agreeable, confused, hostile, haggler, plan-seeker × 3 purposes × 4) in isolated in-memory worlds; arms rules / model / oracle; dollars committed vs a naive agent; breaches; clean outcome. `npm run eval:personas` → `eval/personas.md` (rules brain 60/60 clean, 0 breaches). Explorer `/ops/eval` with chips, CSV, Markdown.

## B.6 Owner trust
`src/guard/dryrun.ts` (gate: kill → integer → provenance → policy caps → live PayPal state → autonomy; holds create approvals and notify the owner's channels; `decideApproval` requires a passkey above `CB_COUNTERSIGN_ABOVE_CENTS` once one is registered; `approvedFor` lets the retry through). `src/guard/policy.ts` (plain words → rules, refused list, unexpressed list, clamps). `src/guard/backtest.ts` (48 by-hand calls, run/wait/deny, earned autonomy). `src/guard/{kill,audit,provenance,passkey}.ts`. Page `/ops/guard`.

## B.7 PayPal depth
Orders, Invoicing v2, Catalog Products, Billing Plans, Subscriptions, Payments refunds, Transaction Search, Balances, webhook signature verification and simulator (`src/paypal/client.ts`); negative paths (`withMockResponse`) and demo faults (503, lost response) on `/ops/money` and `/demo`.

## B.8 Channels and surfaces
`src/channels/index.ts` (SMS via Twilio Messages, Telegram, WhatsApp Cloud API with reply buttons, simulator), `src/channels/handlers.ts` (owner approve/decline buttons, customer STOP revokes consent, status replies), `src/channels/push.ts` (VAPID web push), PWA manifest and service worker.

## B.9 Structural tests
`test/structural.test.ts`: the AI layer never imports PayPal, services, guard or voice; no schema carries money/percentage/phone/id; the key never reaches a body; every PayPal write in the services is preceded by `gate(`; the harness never names a write; consent is enforced in code by the planner and `startCall`.

## B.10 Evidence and judge mode
`/ops/evidence` (numbers the build produced), `/judge` (five beats).

## Still simulated until keys arrive
Phone calls and SMS (Twilio), live voice (OpenAI Realtime), Telegram/WhatsApp delivery, web push, PayPal itself. Each path is exercised by tests through fakes and switches to the real API on the env var with no code change.
