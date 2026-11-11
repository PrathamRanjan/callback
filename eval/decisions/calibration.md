# Decisions thresholds: calibration report

Run 2026-11-11T00:49:14.020Z on gpt-6-luna against the live Decisions API. 65 hand-written messages (34 tuning, 31 held out; every message is written by the author, none are real). Thresholds are chosen on the tuning half with a miss costing 5× a false hold; the precision and recall below are measured on the held-out half only.

| Question | Clear below | Hold at or above | Tuning / held-out | Held-out yes | Precision at hold | Recall at hold | Held-out yes called clear | Note |
|---|---|---|---|---|---|---|---|---|
| impersonation | 0.5 | 0.85 | 34 / 31 | 3 | 100% | 67% | 0 | calibrated |
| urgency_or_secrecy | 0.9 | 0.9 | 34 / 31 | 3 | 75% | 100% | 0 | calibrated |
| changed_payment_details | 0.5 | 0.5 | 34 / 31 | 16 | 89% | 100% | 0 | calibrated |
| pay_outside_paypal | 0.75 | 0.75 | 34 / 31 | 17 | 89% | 100% | 0 | calibrated |
| gift_cards_or_crypto | 0.2 | 0.7 | 34 / 31 | 1 | 100% | 100% | 0 | too few yes examples in the tuning half (1 of 34); kept 0.7/0.2 |
| fee_to_release | 0.5 | 0.5 | 34 / 31 | 1 | 100% | 100% | 0 | calibrated |
| code_or_link | 0.85 | 0.85 | 34 / 31 | 2 | 50% | 100% | 0 | calibrated |
| overpay_and_refund | 0.2 | 0.7 | 34 / 31 | 1 | 100% | 100% | 0 | too few yes examples in the tuning half (1 of 34); kept 0.7/0.2 |
| too_good_to_be_true | 0.2 | 0.7 | 34 / 31 | 1 | 50% | 100% | 0 | too few yes examples in the tuning half (1 of 34); kept 0.7/0.2 |
| asks_for_payment | 0.5 | 0.5 | 34 / 31 | 21 | 95% | 100% | 0 | calibrated |
| names_a_payment_destination | 0.5 | 0.5 | 34 / 31 | 15 | 100% | 100% | 0 | calibrated |

Between the two thresholds an answer counts as unsure: the message is shown amber and never green. A refusal counts as not decided.
