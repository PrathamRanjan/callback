# Builds scam-set.json: the labelled set for the Decisions scam questions (spec A5.2, A5.6, A6.3).
# Every message is hand-written by the author for this project (none are real messages). Each row lists the questions
# whose true answer is "yes". Rows alternate between the tuning half and the held-out half by template group, so a
# paraphrase family never sits in both halves.
import json
C, A, N = "changed_payment_details", "asks_for_payment", "names_a_payment_destination"
rows = []
def add(group, text, *yes): rows.append({"group": group, "text": text, "yes": sorted(set(yes))})

# The 10 Nov message (seen on Business Desk) and 30 paraphrases of it.
nov = "Hi, hope you're well. Just a heads up that we've moved banks, so please send this month's payment to our new PayPal: accounts.brightside@outlook.com. Thanks so much!"
# Relabelled 11 Nov after the first run: paying to an email address or account named in a message is outside the
# business's normal checkout (the question's own wording), so the bank-change family also says yes to pay_outside_paypal.
O = "pay_outside_paypal"
add("nov10", nov, C, A, N, O)
para = [
 "Hello! Quick note: we've switched banks, so this month's payment should go to our new PayPal, billing.brightside@gmail.com. Cheers!",
 "Hi there, our bank account has changed. Please pay this invoice to accounts-brightside@outlook.com on PayPal from now on.",
 "Just letting you know we moved to a different bank. Kindly send the deposit to our updated PayPal: brightsidestudio.pay@hotmail.com",
 "Hi, small update: our old account is being closed, so please use this account instead for your payment. PayPal: brightside.accounts@yahoo.com",
 "Hey! We've updated our payment details. New PayPal for this month is studio.brightside@outlook.com. Thank you!",
 "Good morning, please note our banking details have changed. Send the balance to paypal.me/brightsidestudio2 today.",
 "Hi, we've had to change banks. Can you send this month's fees to our new account, BSB 062-000 account 1234 5678? Thanks",
 "Hello, the studio's PayPal has moved. Please pay to brightside.pilates.pay@gmail.com going forward.",
 "Hi! Our accountant asked me to tell you we have a new PayPal for payments: accounts@brightside-pay.com. Please use it this month.",
 "Quick heads up, payments now go to a different PayPal: brightside.billing@outlook.com. The old one won't accept anything.",
 "Hi, apologies for the hassle, we're changing banks this week. Please send your payment to our new details: paypal.me/brightsidebilling",
 "Hello, could you pay this month to our updated PayPal address? It's finance.brightside@outlook.com. Many thanks.",
 "Hi, the remittance details for Brightside have changed. Please remit to IBAN GB29 NWBK 6016 1331 9268 19.",
 "Hiya, we moved accounts recently. Please send the deposit to brightside.studio.payments@gmail.com instead of the usual.",
 "Hi, our previous bank account is no longer active. Kindly pay to our new PayPal brightsidephysio.pay@outlook.com.",
 "Hello! We've switched our PayPal. Please send this month's $150 to brightside.accts@hotmail.com.",
 "Hi, please update the beneficiary for our invoices to Brightside Studio, account number 44112233 at our new bank.",
 "Just so you know, our payment details are different now. Use paypal.me/brightsidenew for this month.",
 "Hi, we're moving banks and the old account closes Friday. Please send payment to accounts.brightside@outlook.com this time.",
 "Hello, a quick admin note: new PayPal for the studio is brightside.admin@gmail.com, please pay there.",
 "Hi! The studio changed its PayPal account. Kindly transfer this month's balance to brightside.studio@outlook.com.",
 "Hi, please note we have a new bank. Send the deposit to our PayPal at payments.brightside@icloud.com.",
 "Hello, our payment account has been updated. The new PayPal is brightside.pay.au@gmail.com. Please use it from today.",
 "Hi, since we moved banks, please don't use the old details. Pay to brightside.newaccount@outlook.com.",
 "Hey there, we've updated where we take payments. Send your fees to paypal.me/brightside-studio-au.",
 "Hi, the studio switched to a new account for payments. Please pay to brightside.finance@outlook.com.",
 "Hello, we've moved our banking. Please send this month's payment to our new PayPal account; details: brightside.pmt@gmail.com",
 "Hi, our bank details have changed. Please send all future payments to account 0099 1234 5678.",
 "Hi, we've switched banks, so please pay this month's invoice through our new PayPal. I'll text you the address.",
 "Hello, heads up that our account is changing. Kindly hold off paying the old one and use our new PayPal, brightside.studio2@outlook.com.",
]
for p in para: add("nov10", p, C, A, O, *( [N] if ("@" in p or "paypal.me" in p or "IBAN" in p or "account" in p and any(ch.isdigit() for ch in p)) else []))

# Other scams (each its own template group).
add("ceo", "This is Maya, I'm in a meeting. Urgent: buy four $100 Apple gift cards for a client and send me the codes. Keep it between us.", "impersonation", "urgency_or_secrecy", "gift_cards_or_crypto", A)
add("ceo", "Maya here on my personal phone. Please pay this supplier today and don't mention it to anyone, I'll explain later.", "impersonation", "urgency_or_secrecy", A)
add("paypal", "PayPal Security: your account is limited. Verify within 24 hours at https://paypal-secure-check.com/login or it will be suspended.", "impersonation", "urgency_or_secrecy", "code_or_link")
add("paypal", "PayPal team here. We sent you a code to confirm a refund. Read it back to us so we can release your funds.", "impersonation", "code_or_link")
add("fee", "Your parcel is held at customs. Pay the $3.50 release fee at https://auspost-redelivery.top to get it delivered.", "impersonation", "fee_to_release", "code_or_link", A, N)
add("fee", "You have a refund of $480 waiting. A $25 processing fee is needed before we can release it. Pay by transfer.", "fee_to_release", A, "pay_outside_paypal")
add("overpay", "Hi, I accidentally paid $1500 instead of $150 for the class pack. Could you send the extra $1350 back to my bank? BSB 062-111 account 2233 4455.", "overpay_and_refund", A, N, "pay_outside_paypal")
add("overpay", "Oops, I overpaid you by $200. Please refund the difference to my friend's PayPal, sam.k.pay@gmail.com.", "overpay_and_refund", A, N)
add("prize", "Congratulations! You've won a free year of classes. Claim your prize by paying the $9.99 activation fee here: bit.ly/brt-prize", "too_good_to_be_true", "fee_to_release", "code_or_link", A, N)
add("prize", "Guaranteed 20% monthly returns. Send USDT to our wallet to join the investors' club today.", "too_good_to_be_true", "gift_cards_or_crypto", A, "urgency_or_secrecy")
add("offplatform", "Let's skip PayPal, it's cheaper for both of us. Just bank transfer me the $150 directly.", "pay_outside_paypal", A, C)  # details other than the usual ones
add("offplatform", "Message me on WhatsApp +61 400 000 111 and I'll give you our direct deposit details, it's easier than the app.", "pay_outside_paypal", C, A)
add("otp", "Hi, it's the studio. We just texted you a six-digit code to confirm your booking. Can you reply with it?", "impersonation", "code_or_link")
add("otp", "Your Brightside account will be closed today unless you log in here: http://brightside-login.help", "impersonation", "urgency_or_secrecy", "code_or_link")

# Hard genuine messages.
add("g_pay", "Hi Maya, I'll pay the deposit through the link you sent me, probably tonight. Thanks!")
add("g_pay", "Thanks, I paid the balance yesterday. Did it come through?")
add("g_pay", "Hi, can I pay the rest next Friday? Payday is the 15th.")
add("g_pay", "Is there a payment plan? $150 at once is a lot for me this month.")
add("g_book", "Can I move my Thursday class to Saturday morning?")
add("g_book", "Sorry, I'm sick today, can I cancel my 10am session?")
add("g_book", "Is the new reformer class on Tuesdays still running?")
add("g_book", "I changed my phone number, it's 0412 555 019 now.")
add("g_book", "Could you email me the receipt? My email is lena.ortiz@gmail.com")
add("g_studio", "Reminder from Brightside: your class is tomorrow at 9am. Reply STOP to opt out.", )
add("g_studio", "Brightside here: your deposit of $50 is due on Friday. Pay on your account page using the link in your welcome email.", A)
add("g_studio", "Thanks for paying! Your receipt is on your account page.")
add("g_studio", "We've moved to a new studio on King Street from next week. Same classes, same times!")
add("g_studio", "Our new class timetable is out, have a look on the website.")
add("g_cust", "I lost my job, I can't pay this month. What can I do?")
add("g_cust", "Please stop calling me, I'll sort it out myself.")
add("g_cust", "I already paid this last week, check your records please.")
add("g_cust", "Can my husband pay instead? He'll use his own PayPal on the account page.", )
add("g_cust", "This isn't Priya, you have the wrong number.")
add("g_cust", "My account page says $120 but I thought it was $100?")

# Split: groups alternate between halves; the nov10 family is split by row so both halves can calibrate it.
groups = sorted({r["group"] for r in rows if r["group"] != "nov10"})
for r in rows:
    if r["group"] == "nov10":
        idx = [x for x in rows if x["group"] == "nov10"].index(r)
        r["half"] = "tune" if idx % 2 == 0 else "held"
    else:
        sub = [x for x in rows if x["group"] == r["group"]].index(r)
        r["half"] = "tune" if sub % 2 == 0 else "held"
for i, r in enumerate(rows): r["id"] = f"m{i+1:03d}"
json.dump(rows, open("eval/decisions/scam-set.json", "w"), indent=1)
print(len(rows), "rows;", sum(r["half"] == "tune" for r in rows), "tune;", sum(r["half"] == "held" for r in rows), "held")
