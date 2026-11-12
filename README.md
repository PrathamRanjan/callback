# Callback

**An AI voice agent that makes a small business's money calls: confirming tomorrow's deposit, chasing an overdue invoice, settling a cancelled class. Every amount comes from code and the records; PayPal moves the money.**

**Live demo:** https://pph-callback.onrender.com (no account needed: press **Try the demo**)
**License:** MIT · **Built for:** the PayPal AI Hackathon, November 2026

---

## Overview

### The problem

Studios, clinics and salons run on bookings and get paid late. A deposit unpaid the day before an appointment usually means a no-show. An invoice 30 days overdue needs someone to pick up the phone and offer a payment plan. A cancelled class needs a refund or a credit. Owners know these calls matter, but they are awkward, and they are made between clients, so they get put off. Email reminders get archived.

Automating the call has two problems that most "AI agent" demos skip:

1. **A language model must not decide money.** If the agent can be talked into a bigger discount or a refund to a different account, it will be. A caller who haggles, lies or claims to be the owner is the normal case, not an edge case.
2. **Customers have learned not to trust payment requests.** Scam texts and calls have taught people never to tap a pay link from a number they don't know. An honest business calling about a real deposit now sounds just like a scammer.

### What we built

Callback lets the model handle the conversation while code handles the money, and it gives the customer a way to check that the call is real.

- **The model talks; code decides.** The call agent (`gpt-6.1-sol`, with `gpt-live-1` for live voice) chooses between option ids such as "pay link for the deposit" or "three-month plan". Its tool schema has **no amount field**. Every number is computed from the business's records and the owner's rules, and every money move goes through **one dry-run gate** (`src/guard/dryrun.ts`). The gate checks kill switches, integer money, provenance (an amount heard only in speech is denied), the policy's caps, live PayPal state and the owner's autonomy limits before PayPal is called.
- **PayPal does the money, end to end.** Pay links (Orders v2), a saved wallet (Vault), invoices (Invoicing v2), instalment plans (Catalog products, then Billing plans, then Subscriptions), refunds (Payments v2), deposit holds (authorize, capture, void), Transaction Search, Balances and verified webhooks. Each request carries a fixed request id so a retry can't charge twice. Each result is **read back from PayPal** before the record says "paid".
- **The owner stays in charge without being on the phone.** Anything above the owner's limit is **held**: the agent says so on the call, and the owner gets the hold on the Approvals page, as a phone notification, or in **Telegram with Approve and Decline buttons**. Large amounts can require a **passkey countersign over a hash of the exact payload**, so the approval can't be reused for a different payment.
- **The customer can tell a real call from a scam.** Every call says it is an AI and gives a short verify code. The customer checks the code on the business's own page. Messages are read by **four scam checks**, and one of them is a **model we trained ourselves that runs in the customer's browser**, so the warning appears before they tap anything and nothing they paste is uploaded.

### The impact

- **For the business:** the calls that bring in deposits, invoice payments and plans get made the same day, within consent, do-not-call rules and local calling hours (an 08:00–21:00 floor in the customer's time zone), and within limits the owner sets in plain words.
- **For the customer:** no app and no account. They get a call they can verify, a code, and a PayPal page in their own language.
- **For everyone else:** the app is usable by screen reader, at 200% text, hands-free with your eyes and voice, and in **four languages**: English, Hindi, Indonesian and Brazilian Portuguese.

---

## Judging criteria: why Callback deserves to win

### Technological implementation

- **Safety is in code, not in the prompt.** One gate (`src/guard/dryrun.ts`) checks every money move from every source: the call agent, the Ask agent, the MCP server and the owner's own buttons. The model's schema has no amount field. Invented dollar figures are replaced with the record's figure. Ask removes any sentence that states a dollar amount it can't cite.
- **Deep PayPal integration:**
  - Orders v2 (capture, plus authorize, capture and void for deposit holds), Vault, Invoicing v2, Catalog, Billing plans, Subscriptions, Payments v2 refunds, Transaction Search, Balances, verified webhooks, and OAuth with 29 scopes.
  - **PayPal's own MCP server** over SSE, limited to 11 read tools out of its 46.
  - Fixed request ids for idempotency, a read-back before a record changes, and PayPal checkout in the customer's language.
- **Three AI systems, each used for what it's good at:**
  - `gpt-6.1-sol` is the call brain, the policy reader, the Ask agent loop (at most 8 steps or 45 seconds) and the translator.
  - `gpt-6-luna` on the **Decisions API** answers yes/no scam questions and decides when to stop a call. Its thresholds were calibrated on 65 messages (34 for tuning, 31 held out, with a miss costing five times a false hold) and are stored in `src/ai/thresholds.json`.
  - `gpt-live-1` provides realtime voice over WebRTC in the browser, and over Twilio Media Streams on a real phone.
- **Our own on-device model:** a fine-tuned MiniLM encoder, quantised to int8 ONNX (23 MB) and run with onnxruntime-web. It feeds trained heads for scam type and nine scam tactics. A monotone LightGBM model scores payment risk. Both are covered in [their own section below](#a-model-we-trained-that-runs-in-your-browser).
- **Evidence published for every build:**
  - 158 unit, flow and journey tests;
  - 30 Playwright browser tests (29 run, 1 skipped on purpose);
  - 60 scripted customer personas, run with zero rule breaches;
  - 25 adversarial attacks;
  - an AI regression set (8/8 call turns, 4/4 policy, 30/31 scam);
  - a robot judge on GitHub Actions (18/18);
  - a live voice suite (19/19 on Render).
  - The `/proof` page lists every case, failures included.

### Design

- **One design system, "Signal",** runs from the landing page to the customer's pay page, in light and dark mode. It uses a waveform motif, Bricolage Grotesque headings, Hanken Grotesk body text, JetBrains Mono for ids and tabular figures, and an always-dark "console" for live calls.
- **The three-lane call view** puts voice, rules and money on one timeline, so you can see the moment the gate stepped in.
- **Status is never shown by colour alone:** every state has a shape and a word.
- **A guided walkthrough** of 16 owner steps casts you as the owner, hands you the phone as the customer, then hands you back to the owner to approve the held charge.
- **Accessibility is designed in, not added afterwards** (see [Accessibility](#accessibility)).

### Potential impact

- **Who it's for:** small businesses that run on bookings and deposits. The demo studio, Brightside Physio & Pilates in Sydney, is typical.
- **Protection on both sides.** The owner is protected from an agent that gives money away. The customer is protected from impersonators, through verify codes, an inbound scam check, refusals to refund to a different account, and refusals of callers who claim to be the owner.
- **Reach.** Four languages, including two scripts, plus screen readers, large text and hands-free control. Customers need no app and no account.

### Innovation

- **An outbound AI agent that negotiates money,** with a person's limits enforced in code and with earned autonomy: limits are suggested only from the owner's own approvals, and never past one of their declines.
- **A scam model in the customer's browser,** so the warning arrives before the tap and the message never leaves the device.
- **Bring your own agent.** Claude or any MCP client can connect to Callback's MCP server and propose payments, held to exactly the same gate as Callback's own agent.
- **Four independent scam checks.** A message is called safe only when all four ran and none found anything.
- **Hands-free "Look and Say":** look at a button and say its name. Money actions need a confirmation card that is enforced in code.

---

## The product

### For the owner

| Page | What it does |
|---|---|
| **Today** | Plans the day's calls from the records and from PayPal: deposits unpaid before tomorrow's appointment, invoices past the grace period, cancelled classes. It shows every call it refused and why (no consent, do-not-call, outside calling hours, cooldown). |
| **Calls** | Each call has its transcript, the options offered, every tool call and gate decision, and every PayPal request id. Calls can run in the simulator (you type as the customer, or play one of 60 personas), as live voice in the browser, or as a real phone call. |
| **Approvals** | Holds with what, who, why and how to undo it. Approve by tap, Telegram button or passkey. Also has autonomy limits, kill switches and the hash-chained audit log. |
| **Money** | Pay links, invoices, plans, refunds and credits, each with its PayPal read-back. |
| **Rules** | The policy is written in plain words and compiled into typed rules. Rules are clamped so no policy can break legal calling hours or switch off consent. The page also says what it couldn't express, and backtests the rules over 90 days of past calls. |
| **Ask** | An agent you ask in plain words ("who owes us more than $200?"). Each tool it uses streams into a side rail. It uses Callback's MCP server and PayPal's, with read tools only. |
| **Safety** | Checks a message, lists flagged inbound messages, shows the holds the safety layer created, and has protected mode. |
| **Messages** | Texts and replies, with machine translation on demand. |
| **Connect your assistant** (`/agents`) | MCP config, a hidden demo key and a live log of MCP requests. |

### For the customer

The customer gets a private page at `/c/:token`. There they can see what they owe, **pay with PayPal** (through PayPal's checkout or a saved wallet), check the verify code, paste a suspicious message to check it on the device, ask for a callback or say stop. They have **no app and no account**.

### Pages anyone can open

`/proof` (every evaluation case), `/ai` (the last model calls), `/paypal` (each PayPal API with a live id), `/who-can-move-money`, `/accessibility` and `/agents`, plus `/llms.txt` and `/skill.md` for AI agents.

### All the features

**Calls and conversation**
- Outbound calls in three modes that share one brain and one gate: the simulator, live voice in the browser (`gpt-live-1` over WebRTC), and real phone calls (Twilio Media Streams, signature-verified webhooks).
- The agent says it is an AI, gives a verify code and offers only what the rules allow. When a payment is held, it tells the customer so on the call.
- The call switches language when the caller does. Transcripts are stored exactly as spoken.
- Consent, do-not-call and calling hours are enforced in code before anything rings. A refused call is shown with the reason.

**Money through PayPal**
- Pay links, saved-wallet payment, invoices, instalment plans, discount steps, refunds and account credits.
- Deposit holds that are authorized now and captured or voided later.
- Verified webhooks keep the records in step with PayPal, with a read-back before anything is marked paid.
- Idempotent requests, so a retry never charges twice.

**Control and trust**
- One dry-run gate for every money move, plus holds and approvals.
- Passkey (WebAuthn) countersign over the payload hash.
- A hash-chained audit log, kill switches, and earned autonomy that never goes past a decline.
- Approvals by Telegram (@paypalhackathonbot, with Approve and Decline buttons) and by web push; the app installs as a PWA.

**Scam and fraud protection**
- Four scam checks: rules, the Decisions API, a comparison of where the message asks you to pay against the business's own record, and the on-device model.
- A verify code on every call, and an inbound scam check that replies to the customer with a warning.
- Refunds to a different account are held. Callers who claim to be the owner are refused.

**Agents**
- Ask, with a visible tool rail.
- Callback's own MCP server (owner at `/mcp`, customer at `/c/:token/mcp`).
- PayPal's MCP server, read tools only.
- Outside agents go through the same gate as Callback's own.

**Demo infrastructure**
- Every visitor gets a **private Postgres schema** (`cbws_<id>`) built in a few seconds. At most 40 copies are live at once, idle copies expire after 48 hours, and each IP address can start 5 per hour.
- The studio clock is pinned to one morning so the walkthrough always works.
- A Render Blueprint (`render.yaml`) defines the web service, worker, crons and preview environments.

---

## A model we trained that runs in your browser

Most "AI scam detection" sends your message to a server. Ours runs **inside the customer's browser**. A customer who pastes a suspicious text into their page gets a verdict without the text leaving their device.

**What it is**
- **Base:** `sentence-transformers/all-MiniLM-L6-v2` (22M parameters), fine-tuned with SetFit contrastive learning on scam versus not-scam.
- **Heads:** trained linear heads on the 384-dimensional embeddings. One head sorts a message into **genuine, marketing or scam**. Nine more each detect one **scam tactic**: impersonation, urgency and secrecy, changed payment details, moving off-platform, gift cards or crypto, a fee to release money, an OTP or link, overpay-and-refund, and too-good-to-be-true.
- **Export:** ONNX with int8 per-channel dynamic quantisation, **23 MB**. The heads were refit on the quantised graph's own embeddings, so the browser and Python agree.
- **Runtime:** `onnxruntime-web` 1.22 runs the encoder in the browser, and a WordPiece tokenizer written in plain JavaScript prepares the text. The files are `public/safety/model/` (`model_quantized.onnx`, `tokenizer.json`, `wordpiece.js`) and `public/safety/model/heads.json` (the hold threshold of 0.891 is set so that 1% of genuine validation messages are held).
- **Training data:** about 80,000 deduplicated messages from public SMS, Telegram and email scam and spam sets, plus 600 business-scam and hard-genuine examples we wrote ourselves. Sources and licences are listed in [`guard-lab/SOURCES.md`](guard-lab/SOURCES.md). The dataset itself is not in the repository, because of its size and licences.
- **Training code:** [`guard-lab/scripts/`](guard-lab/scripts/). The model was trained on a laptop (Apple M4 Pro, MPS).

**How well it works,** on frozen test sets it never trained on (from the [model card](guard-lab/MODEL_CARD.md), also at `/safety/model-card` in the app):

| Test set | Messages | AUC | Caught at 1% genuine held | Note |
|---|---|---|---|---|
| ScamShield SMS test | 8,188 | 0.988 | 75% | real SMS, in distribution |
| ScamShield eval sets | 1,574 | 0.979 | 67% | real and hand-written |
| Singlish genuine | 600 | n/a | 1.0% held | false-alarm check on real everyday messages |
| Business templates | 200 | 0.85 | 11% | held-out templates we wrote |
| Business email (BEC) seed | 200 | 0.58 | 25% | the model is weak here |

On the parity test, the browser and Python reach the same hold decision on 197 of 200 messages; the 3 that differ come from int8 arithmetic in different runtimes.

**Where it is weak, and how the product handles it.** The model is weak on business email impersonation (AUC 0.58). That is why "someone claims to be the owner" is also a hard rule, and why a message is called safe only when all four checks agree. The model's output can never approve a payment: it can only raise the hold level that the gate then enforces.

**The payment-risk model.** A LightGBM model with 300 trees and **monotone constraints**, so a scam signal can only raise the risk. It is exported as JSON and evaluated in plain JavaScript (`public/safety/risk_lgbm.json`). **It was trained on synthetic data** generated from FTC and FBI IC3 scenario mixes, so its score is a ranking signal shown next to the rule reasons, never a fraud rate.

---

## Accessibility

Accessibility was a requirement from the start, checked by tests on every build.

- **WCAG 2.2 AA:** axe finds 0 serious or critical issues across 46 page views of 22 pages, for every role (visitor, owner, front desk, customer), light at 1280 px and dark at 375 px.
- **Reflow:** pages are checked at 320 px wide with the largest text size, and at 200% zoom, with no sideways scrolling.
- **Keyboard only:** you can approve a held payment from start to finish with the keyboard. Focus is visible, and there is one polite live region for updates.
- **Display and help panel,** on every page: text size, high contrast, the Atkinson Hyperlegible font, calm mode (no motion), bigger targets, read-aloud, plain words and more time. Choices are saved on the device. Reduced-motion settings are respected.
- **Hands-free "Look and Say"** (Alt+Shift+H, or the eye button):
  - **MediaPipe's face landmarker runs on the device**, and no image or landmark leaves it. You calibrate with nine dots, and the page shows your measured accuracy in pixels.
  - You point by gaze or head movement. You press by dwelling on a button, saying "click", or winking. A wake word ("Callback, …") or push-to-talk handles voice commands.
  - **Anything that moves money, places a call, sends a message or changes consent needs a confirmation card, enforced in code.** PayPal checkout is handed back to your hands.
  - Without a camera it falls back to keyboard scanning.
  - In a simulated benchmark (300 looks at random targets among 48 buttons), it pressed the right button 100% of the time at 20–60 px of gaze jitter, 99.7% at 80 px and 76% at 120 px, with no wrong presses at any level.
- **Push-to-talk dictation** works on Ask, the call simulator and Messages.
- **Not verified yet:** sessions with real screen-reader users, and hands-free use with real people's eyes. The benchmark tests our snapping and dwell code, not a camera.

---

## Languages

The whole app, the calls and the messages work in **English, हिन्दी (Hindi), Bahasa Indonesia and Português (Brasil)**: about 1,600 interface strings in each language.

**Why these four.** Callback is for small businesses that take payments through PayPal and talk to their customers by phone. We chose languages where:
- many small businesses get paid digitally and talk to customers by phone and chat;
- PayPal checkout can open in the same locale (pt-BR and id-ID; Hindi opens PayPal in en-IN, because PayPal has no Hindi checkout);
- together they push the product past English assumptions: a non-Latin script (Devanagari), different number formats (`US$ 1.540,68` in Portuguese), and text that runs much longer than English, which tests every layout.

**How it works**
- Every string goes through `t()`. A glossary keeps terms like PayPal, deposit, hold and do-not-call fixed.
- `scripts/i18n-check.mjs` runs before the tests. It fails on a missing key, a dropped `{placeholder}`, or English text typed straight into a screen.
- **Calls switch language when the caller does.** The greeting uses the language on the customer's record, and the agent carries on in whichever of the four the caller speaks. Transcripts are stored as spoken, and the owner can press **Translate**.
- Texts to a customer go out in the customer's language. Ask answers in the chosen language.
- Money is formatted by code for each locale, so translation never touches a number.
- The translations were made by machine (`gpt-6.1-sol`), and the customer's page and every translated transcript carry a **Machine-translated** label. They have not been reviewed by native speakers.

---

## How it's built

```
web/            React 18 + Vite + Tailwind 4 front end (Signal design system, i18n, hands-free, guided tour)
src/
  guard/        dry-run gate, holds, passkey countersign, audit chain
  paypal/       Orders, Vault, Invoicing, Billing/Subscriptions, refunds, webhooks, PayPal MCP client
  ai/           model calls, Decisions API client and thresholds, call brain, policy reader
  agent/        Ask agent loop (Callback MCP + PayPal MCP, read-only tools)
  voice/        live voice (WebRTC), Twilio Media Streams bridge
  channels/     Telegram bot, web push, SMS, inbound scam check
  core/         consent, calling hours, payment plans
  safety/       the four scam readers and the risk model
  mcp/          Callback's MCP server
  services/     planner, per-visitor workspaces, demo seeding
  web/          server-rendered pages (safety, proof, ai, paypal) and the API
public/safety/  on-device model (ONNX int8 + heads) and the LightGBM risk model
guard-lab/      training scripts, reports, model card and data sources for the on-device models
eval/           personas, adversarial attacks, Decisions calibration set, results
e2e/            Playwright journeys, axe checks, language and hands-free journeys
render.yaml     Render Blueprint
```

**Stack:**
- **Server:** TypeScript and Node with Express; Postgres on Render (PGlite locally); WebSockets for the voice bridge.
- **Front end:** React, Vite, Tailwind, Radix, driver.js.
- **Models and AI:** OpenAI `gpt-6.1-sol`, `gpt-6-luna` (Decisions) and `gpt-live-1`; MediaPipe Tasks Vision; onnxruntime-web; LightGBM.
- **Services and standards:** the PayPal REST APIs and PayPal MCP server, Twilio, the Telegram Bot API, Web Push, WebAuthn, and the MCP SDK.

**Sponsor technology used:** **Render** hosts the web service, a Postgres database with a private schema per visitor, health checks and the Blueprint, alongside PayPal and OpenAI. We did not use the other sponsor tools.

---

## Run it yourself

You need Node 20.11 or later and PayPal sandbox credentials. An OpenAI API key is needed for calls and policy reading.

```bash
npm install
```

```bash
cp .env.example .env
```

Add `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` (sandbox) and `OPENAI_API_KEY`. Twilio, Telegram and VAPID keys are optional.

```bash
npm run seed -- --pin
```

This seeds Brightside Physio & Pilates with 8 customers and prints the owner key.

```bash
npm run dev
```

Then open http://localhost:3500 and sign in with the owner key, or use **Try the demo**.

**Without some keys:**
- Without PayPal credentials, every page still works and money moves fail with a clear error.
- Without an OpenAI key, calls don't start and the policy reader shows an error. Nothing written by rules is ever shown as AI.
- Without Twilio, the simulator handles calls.
- Without channel tokens, messages are recorded as *simulated*.
- The deployed server refuses to start without its AI and PayPal keys.

**Tests and evaluations**

| Command | What it runs |
|---|---|
| `npm test` | the i18n check, then 158 unit, flow and journey tests (with route coverage) |
| `npm run e2e` | Playwright browser journeys: core flows, axe, reflow, one full flow per language, hands-free |
| `npm run typecheck` | TypeScript across the server and the web app |
| `npm run sandbox:check` | PayPal credentials, scopes and webhook |
| `npm run eval:personas` | 60 scripted customers, compared against a naive agent |
| `npm run eval:adversarial` | 25 attacks on the agent and the gate |
| `npm run eval:ai` | the AI regression set (call turns, policy, scam) |
| `npm run calibrate` | refits the Decisions thresholds from `eval/decisions/` |

---

## Try the live demo

1. Open https://pph-callback.onrender.com and press **Try the demo**. If the site has been idle, the first load can take up to a minute.
2. Choose **Start as the owner**. Your first tap builds a private copy of the demo studio. Nobody else sees what you do, and the copy is removed after two days without a visit.
3. Follow the guided walkthrough, about 5 minutes:
   - the agent calls Priya about her $60 deposit;
   - you take the phone as the customer and pay with the saved sandbox wallet (no PayPal login needed);
   - you go back to the owner to approve a charge that was held for being over the limit.
4. You can also try **A customer** (about 1 minute: pay, then check a suspicious message on the device) or **the front desk** (runs calls but can't move money).

**What is real and what is simulated.** Real: the PayPal sandbox (orders, wallet, invoices, plans, refunds and webhooks are created there and read back), the OpenAI models, live voice in the browser, Telegram approvals and web push. Simulated, and labelled on screen: calls and texts to the made-up demo customers, the seeded history, and each copy's clock. The real phone line rings only numbers on an allowlist.

---

## More detail

- [`docs/BUILD_LOG.md`](docs/BUILD_LOG.md): the full build log, with each wave of work, the live checks and what failed.
- [`guard-lab/MODEL_CARD.md`](guard-lab/MODEL_CARD.md): the on-device model card.
- [`DEVPOST.md`](DEVPOST.md): the hackathon submission text.

## License

MIT. See [LICENSE](LICENSE).
