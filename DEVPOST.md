# Devpost submission: Callback

Every field of the Devpost form, in order. Text you can paste is under each heading. Lines marked **YOU** are personal answers only you can give; where there is a suggestion, check it before submitting.

---

## Project overview

### Project name (max 60 characters)

```
Callback: AI money calls for small businesses
```

(45 characters)

### Elevator pitch (max 200 characters)

```
An AI voice agent that makes a small business's money calls. Code and the owner's limits decide every amount, PayPal moves the money, and customers can check that the call is real.
```

(180 characters)

---

## Project details

### About the project (Markdown)

```markdown
## Inspiration

Small studios, clinics and salons run on bookings, and they get paid late. A deposit that's still unpaid the day before usually means a no-show. An overdue invoice needs someone to pick up the phone and offer a plan. Owners know these calls bring the money in, but the calls are awkward and get made between clients, so they get put off.

An AI agent could make those calls. But two things stopped us from simply plugging in a model:

1. **A model must not decide money.** Callers haggle, lie, and sometimes pretend to be the owner. An agent that can be talked into a bigger discount, or a refund to a different account, will be.
2. **Customers have learned not to trust payment requests.** Scam texts taught people never to tap a pay link from a number they don't know. An honest business calling about a real deposit now sounds just like a scammer.

So we built **Callback**: the AI handles the conversation, code handles the money, PayPal moves it, and the customer gets a way to tell a real call from a scam.

## What it does

- **Plans the day's calls** from the business's records and PayPal: unpaid deposits, overdue invoices, cancelled classes. Before anything rings, it checks consent, do-not-call and local calling hours in code, and shows every call it refused and why.
- **Makes the call.** The agent says it is an AI and gives a verify code. It can call in the browser with live voice (`gpt-live-1` over WebRTC) or on a real phone (Twilio Media Streams), in English, Hindi, Indonesian or Brazilian Portuguese, and it switches language when the caller does.
- **Offers only what the owner's rules allow.** The model picks between option ids; its tool schema has **no amount field**. Every number comes from the records.
- **Moves money only through PayPal, only through one gate.** The gate covers pay links (Orders v2), the saved wallet (Vault), invoices (Invoicing v2), instalment plans (Billing plans and Subscriptions), refunds, and deposit holds (authorize, then capture or void). Each result is read back from PayPal before the record says "paid".
- **Holds anything over the owner's limit.** The agent tells the customer on the call. The owner approves in the app, through a phone notification, or in **Telegram with Approve and Decline buttons**. A passkey can be required to countersign the exact payload.
- **Protects the customer.** Four scam checks read every message, and one of them is **a model we trained ourselves that runs in the customer's browser**. A pasted message never leaves the device.
- **Lets you bring your own agent.** Claude or any MCP client can connect to Callback's MCP server, held to exactly the same gate as Callback's own agent.

## How we built it

- **Server:** TypeScript on Node and Express, with Postgres on **Render**. Every demo visitor gets a private Postgres schema, built in a few seconds and removed after 48 hours idle. One `render.yaml` Blueprint defines the web service, worker, crons and preview environments.
- **The gate** (`src/guard/dryrun.ts`) is the heart of it. Every money move from the call agent, the Ask agent, MCP or the owner's own buttons passes through it. It checks kill switches, integer money, provenance (an amount heard only in speech is denied), the policy's caps, live PayPal state and the owner's autonomy limits. Then it either calls PayPal with a fixed request id or creates a hold. Every step lands in a hash-chained audit log.
- **PayPal:** Orders v2, Vault, Invoicing v2, Catalog, Billing plans, Subscriptions, Payments v2 refunds, Transaction Search, Balances, verified webhooks, and **PayPal's MCP server**, limited to 11 read tools out of its 46. Checkout opens in the customer's language.
- **The AI:**
  - `gpt-6.1-sol` is the call brain. It also turns a policy written in plain words into typed rules, which are backtested on 90 days of past calls. It runs the Ask agent (at most 8 steps, each tool call streamed into a side rail) and does the translations.
  - `gpt-6-luna` on the **Decisions API** answers yes/no scam questions and decides when to stop a call. Its thresholds were calibrated on 65 messages: 34 for tuning, 31 held out, with a miss counted as five times worse than a false hold.
  - `gpt-live-1` provides realtime voice.
- **The on-device model:**
  - We fine-tuned MiniLM (SetFit) on about 80,000 deduplicated scam and genuine messages.
  - We trained heads for genuine, marketing or scam, and for nine scam tactics (impersonation, urgency, changed payment details, gift cards or crypto, and others).
  - We quantised the model to **int8 ONNX (23 MB)** and run it with onnxruntime-web, using a WordPiece tokenizer written in plain JavaScript.
  - On a frozen real-SMS test set it scores **AUC 0.988**. In a parity test on 200 messages, the browser and Python make the same decision on 197.
  - A monotone **LightGBM** model scores payment risk. It was trained on synthetic data, so we show it as a ranking signal, never as a fraud rate.
- **Front end:** React, Vite and Tailwind, with our own design system ("Signal"). A driver.js walkthrough lets you play the owner, then the customer, then the owner again.
- **Accessibility:**
  - axe (WCAG 2.2 AA) runs on every build: 0 serious issues across 46 page views.
  - Pages reflow at 320 px wide with the largest text, and at 200% zoom.
  - The app works with the keyboard alone, and has a Display and help panel.
  - **Hands-free "Look and Say"** uses MediaPipe's face landmarker on the device: look at a button and say its name, or dwell or wink to press it. Money actions need a confirmation card enforced in code.
- **Evidence:**
  - 158 unit and flow tests and 30 Playwright browser tests;
  - 60 scripted customer personas and 25 adversarial attacks;
  - an AI regression set and a robot judge on GitHub Actions.
  - Every case is published on `/proof`, failures included.

## Challenges we ran into

- **Keeping the model away from money without making it useless.** Our first agent could quote prices. We removed every amount from its tool schema, gave it option ids instead, and added a check that replaces any dollar figure it makes up. Ask now drops any sentence stating an amount it can't cite.
- **Browser and Python disagreeing.** The int8 model gave slightly different scores in onnxruntime-web than in Python. We refit the heads on the quantised graph's own embeddings and added a parity test. Three of 200 decisions still differ, and we say so on the model card.
- **Being honest about weak spots.** The text model is weak on business email impersonation (AUC 0.58). Rather than hide that, we made "someone claims to be the owner" a hard rule. A message is called safe only when all four checks agree.
- **Realtime voice through a gate.** Every function call from the live voice session has to come back to our server and through the gate before the agent can say "done". Keeping that fast enough for natural conversation took several rounds.
- **A demo many people use at once.** One shared demo would let judges see each other's clicks. We built a private Postgres schema per visitor, with per-IP limits and expiry. We also made the server wait out database restarts instead of failing to deploy.
- **Four languages in a payments app.** Money has to be formatted by code, never by translation, and PayPal has no Hindi checkout (we use en-IN). Every translated screen is labelled as machine-translated.

## Accomplishments that we're proud of

- An AI agent that negotiates with real customers while never being able to move money outside the owner's limits, proven by 25 attacks and 60 personas with zero rule breaches.
- A scam model we trained ourselves, running in a customer's browser at 23 MB.
- A product that works by screen reader, at 200% text, hands-free and in four languages.

## What we learned

- The safest place for an AI rule is outside the AI. Prompts drift; a schema without an amount field doesn't.
- Calibration matters more than model size. The multilingual MiniLM-L12 was five times bigger and no more accurate, so the small English model ships.
- Publishing failures (`/proof`, the model card's weak rows) builds more trust than a perfect-looking dashboard.
- Accessibility done early is cheap. Done late, it touches every component.

## What's next for Callback

- Sessions with real screen-reader users, and hands-free trials with real people.
- Native-speaker review of the four translations.
- A business-email scam set to fix the model's weakest area.
- Real payment-risk data in place of synthetic training data.
```

### Built with (max 25 tags)

```
paypal, paypal-orders-api, paypal-vault, paypal-invoicing, paypal-subscriptions, paypal-mcp, openai, gpt-realtime, typescript, node.js, express, postgresql, react, vite, tailwindcss, render, twilio, telegram, webauthn, model-context-protocol, onnx-runtime, mediapipe, lightgbm, sentence-transformers, playwright
```

(25 tags)

### "Try it out" links

```
https://pph-callback.onrender.com
https://github.com/PrathamRanjan/callback
```

### Video demo link

**YOU:** Upload the demo video to YouTube (under 3 minutes) and paste its link here. The rendered videos are in `video/` on your computer; that folder is not committed to the repository because it is 1.3 GB.

---

## Additional info

### Submitter type
**YOU:** Individual, team or organisation.

### Country of residence
**YOU.**

### Province (if Canada)
**YOU:** Only if you live in Canada.

### Organisation name
**YOU:** Leave blank if you are entering as an individual.

### Is this a new project or an existing one (started before 1 October 2026)?
**Suggestion:** New. Callback was built in November 2026 for this hackathon (the repository's first commit is dated 9 November 2026). Confirm before submitting.

### How does your project use PayPal and AI?

```
PayPal moves every dollar; AI handles every conversation; code stands between them.

PayPal: Orders v2 (pay links, plus authorize, capture and void for deposit holds), Vault (saved wallet), Invoicing v2, Catalog products, Billing plans and Subscriptions (instalment plans), Payments v2 refunds, Transaction Search, Balances, and verified webhooks. Every request carries a fixed request id so a retry can't charge twice, and every result is read back from PayPal before our record says "paid". Our Ask agent also connects to PayPal's own MCP server over SSE, limited to 11 read tools out of its 46. Checkout opens in the customer's language.

AI: gpt-6.1-sol runs the call agent, reads the owner's policy written in plain words into typed rules, runs the Ask agent loop and translates. gpt-6-luna on the Decisions API answers yes/no scam questions with calibrated thresholds. gpt-live-1 provides realtime voice in the browser (WebRTC) and on a real phone (Twilio Media Streams). We also trained our own scam model (MiniLM, int8 ONNX, 23 MB) that runs in the customer's browser with onnxruntime-web.

The model never decides an amount: its tool schema has no amount field, and every PayPal call passes one dry-run gate that checks the owner's limits, the records and live PayPal state. Anything over the limit is held for the owner to approve in the app, through a phone notification, or in Telegram.
```

### Sponsor tools used

Tick **Render** only.

Render hosts the web service, a Postgres database with a private schema per demo visitor, health checks, and the `render.yaml` Blueprint (web, worker, crons, previews). We did not use AG Grid, APIMatic, Astropods, Bryntum, Channel3, Elastic, KERNEL, Postman or Zapier, so leave those unticked.

### Public code repository URL

```
https://github.com/PrathamRanjan/callback
```

**YOU, before submitting:** the repository is **private** right now. Devpost requires it to be public. Make it public in GitHub settings (Settings, then General, then Danger Zone, then Change visibility). It already has an MIT LICENSE and a README with setup steps and the PayPal and AI usage.

### Demo URL

```
https://pph-callback.onrender.com
```

### Testing instructions

```
No account or PayPal login needed.

1. Open https://pph-callback.onrender.com and press "Try the demo". If the site has been idle, the first load can take up to a minute.
2. Choose "Start as the owner". Your first tap builds your own private copy of the demo studio (a few seconds). Nobody else sees your clicks, and it is deleted after two days idle.
3. Follow the guided walkthrough (about 5 minutes):
   - the AI calls Priya about her $60 deposit;
   - you take the phone as the customer, check the verify code and pay with the saved sandbox wallet;
   - you go back to the owner and approve a $360 charge that was held for being over the $300 limit.
4. Also try:
   - "A customer" (about 1 minute): pay, then paste a suspicious message. The scam model runs in your browser.
   - Ask: try "who owes us money?" and watch each tool call in the side rail.
   - Hands-free: the eye button in the header, or Alt+Shift+H.
   - The language picker: Hindi, Indonesian or Portuguese.
5. Pages with no sign-in: /proof (every test case, failures included), /paypal (each PayPal API with a live id), /ai (recent model calls), /who-can-move-money, /accessibility, /agents.

Payments use the real PayPal sandbox; nothing real is charged. Calls to the made-up demo customers are simulated and labelled as such. Each IP address can start 5 demos an hour.
```

### Rate your experience with PayPal's developer tools (1–10), and why

**YOU:** Your own rating. Points you could draw on, from building this:
- **Good:** the sandbox covers every API we needed (Orders, Vault, Invoicing, Subscriptions, refunds, webhooks). Request ids made retries safe. PayPal's MCP server let our agent read live data with very little code.
- **Harder:** webhook verification and the plan-to-subscription chain take several calls to set up. Some sandbox states are hard to reproduce. There is no Hindi checkout locale.

### May PayPal contact you about your experience?
**YOU.**

### Experience with APIMatic
**Suggestion:** Did not use it in this project.

### Experience with AG Grid
**Suggestion:** Did not use it in this project.

### Eligibility attestations
**YOU:** Read and tick each one yourself.

### Which AI tools did you use to build the project?
**Suggestion:** confirm and add any others you used.
- **In the product:** OpenAI `gpt-6.1-sol`, `gpt-6-luna` (Decisions API) and `gpt-live-1`; our own fine-tuned MiniLM model; MediaPipe.
- **For building:** Claude Code (Claude Opus) for writing code, tests and documentation.

### Your learning level / AI experience
**YOU.**

### What value did AI tools add?
**Suggestion** (edit to match your experience):

```
AI coding tools let us ship what would normally take a much larger team: eight PayPal APIs, realtime voice, an on-device model, four languages and full accessibility testing, in under two weeks. The biggest value was speed on breadth (tests, translations, accessibility fixes, evaluations). It did not replace judgement: we still chose to keep amounts out of the model, published the model's weak results, and verified every claim against the live sandbox.
```
