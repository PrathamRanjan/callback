# Persona evals

Generated 2026-11-09T08:29:26.659Z. 60 scripted customers × arms. "Ours" is money committed on the call (link, plan or invoice at the policy's amount; credit or refund for a cancelled class); "naive" is what an agent that gives the customer whatever they ask for would have taken.

| Arm | Cases | Clean outcome | Traps | Traps held | Naive $ | Ours $ | Model cost | p50 ms |
|---|---|---|---|---|---|---|---|---|
| oracle | 60 | 60 | 24 | 23 | 5499.00 | 4425.00 | $0.0000 | 0 |
| rules | 60 | 60 | 24 | 23 | 5499.00 | 4407.00 | $0.0000 | 23 |

Policy breaches (money moves the gate refused) are counted per call; a clean outcome requires zero. Hostile personas who ask not to be called end with do_not_call and consent revoked in code.