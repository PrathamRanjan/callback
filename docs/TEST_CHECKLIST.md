# Callback: what to test by hand (10 Nov 2026)

Live app: https://pph-callback.onrender.com. Open `/try` and pick **Owner** unless a step says otherwise. Where a PayPal page opens, sign in as the sandbox test buyer.

These checks need your phone, your accounts or your eyes. Everything else is covered by the automated tests (79 unit and route tests, 10 browser journeys, live journeys on every deploy).

## 1. Telegram alerts and the Approve button (fixed today)
1. Go to **Messages** and tap **Connect Telegram**. Telegram opens; press **Start**.
   - Expect: "Connected. When Callback holds a decision for you, it arrives here with Approve and Decline buttons."
2. Go to **Calls**, open **Harbour Dental**, tap **Start in simulator**, and type `Sure, text me the link`.
   - Expect on Telegram: "Callback held a charge or invoice of $420.00 (…). Approve or decline.", with two buttons.
3. Tap **Approve**.
   - Expect: the spinner stops, the reply "Approved: … of $420.00" arrives, and the hold is gone from **Needs you**.
4. Send `pending` in the chat.
   - Expect: "0 pending approvals".

## 2. Telegram for a customer
1. From any customer's page (Customers → a name → **Their page**), tap **Get updates on Telegram instead** and press **Start**.
   - Expect: "Hi <name>, you're connected."
2. Send `status`.
   - Expect: a list of what they owe, with amounts.

## 3. Payment, then a refund of that payment (Judge tour)
1. Open `/today?tour=judge` and follow it.
2. On Priya's call, tap **Start in simulator** and type `yes, text me the link`. Open the pay link in the Money lane and pay $60 as the sandbox buyer.
3. Next step: on Priya's page, tap **Cancel booking**, give a reason, and confirm.
4. Next step: on her own page, tap **Refund $60.00 to PayPal**.
   - Expect: "Refund of $60.00 sent to the PayPal account you paid with."
   - Expect: on **Money**, the refund shows as completed with a PayPal id.
5. Optional: the sandbox buyer's Activity page should show the payment and the refund. This is the one thing I couldn't see myself, because that page needs its own login.

## 4. Payment plan (Judge tour, next step)
1. On the customer page the tour opens, pick a plan and tap **Set up plan with PayPal**.
2. Approve the subscription as the sandbox buyer.
   - Expect: you land back on the page with "Your payment plan is approved."
   - Expect: within a minute, **Money** shows the plan as active. The worker reads it back from PayPal.

## 5. Live voice in the browser (needs a microphone)
1. Open a ready call and tap **Talk with your voice**. Allow the microphone.
2. Speak as the customer, for example "Yes, send me the link."
   - Expect: the agent answers out loud, and the transcript and the three lanes fill in.
   - Checked on 10 Nov 2026, locally and on the live site, with a recorded sentence played into the browser: one money-gate check, one PayPal order, the call ends as "paid link". Your own voice is still worth one try.

## 6. Browser alerts (needs Chrome or Edge, or an iPhone with Callback added to the Home Screen)
1. On **Messages**, tap **Alerts on this device** and allow notifications.
2. Repeat step 1.2 (the $420 hold).
   - Expect: a pop-up notification. Tapping it opens **Needs you**.
   - Checked on 10 Nov 2026 in real Chrome: the push service accepted the push (201) and the notification showed. Each send now leaves a line on **Messages** saying what the push service answered. If a line says the subscription expired, tap **Alerts on this device** again.
   - On a Mac, also allow Chrome in System Settings → Notifications, or nothing pops up.

## 7. A real phone call and text
Calls and texts only go to numbers on the demo allowlist (`CB_LIVE_CONTACT_ALLOWLIST`).
- Checked on 10 Nov 2026: a real call to a Singapore mobile, and the pay link arrived by SMS. The number was then taken off the allowlist, so the allowlist is empty again.
- To repeat it, send the number to use; it goes back on the allowlist for the test.
- Known gap: replies to the text (for example STOP) don't reach Callback. The Twilio number is shared with other apps and has no reply address set, so it stays that way until someone decides who owns that number. STOP on the call, on the customer page or on Telegram does work.

## 8. On your own phone
1. Open the live URL on your phone. Check the bottom nav, the More sheet and the Judge tour.
2. Try **Display and help** (text size, contrast, read aloud).

---

## What is simulated or seeded, and why

| What | Why | Real alternative already built |
|---|---|---|
| The demo studio, customers and bills | Seed data, so a judge has something to try immediately. Reset from the ribbon. | Add your own customers and charges on **Customers**. |
| Calls and texts to the seeded customers | Their phone numbers are fake, from ranges set aside for fiction, so those calls run in the in-browser simulator | Real Twilio calls and texts to allowlisted numbers (item 7) |
| The demo clock | Pinned inside calling hours so calls are "ready" whenever a judge visits. The ribbon says so. | Real time for real businesses (demo mode off) |
| Tom's cancelled class | Seeded as paid in cash, so there's no PayPal payment to refund. The app says it will be paid back by hand. | The tour refunds the payment you just made, through PayPal (item 3) |
| PayPal | Sandbox, not live money | Set `PAYPAL_ENV=live` with live keys |
| PayPal webhooks | The sandbox listed the events but delivered none of them on 10 Nov 2026. An event resent from PayPal reached the live app straight away and passed the signature check. | A read-back worker asks PayPal for the state of every open payment, plan and refund, so nothing waits on a webhook |
| Render free plan | The service sleeps when idle; the first visit after that takes 30 to 60 seconds | A paid instance |
| Evals (60 customer scripts, 25 attacks) | Run against an in-memory PayPal on purpose, so a run doesn't create hundreds of sandbox orders | The live money paths are exercised by the browser journeys and items 3–4 |

Nothing else is hard-coded. Amounts come from the records, plans and discounts from the owner's rules, and every PayPal id is read back from PayPal.
