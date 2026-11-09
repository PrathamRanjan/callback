# Persona evals

Generated 2026-11-09T16:39:02.570Z. 60 scripted customers × arms. "Ours" is money committed on the call (link, plan or invoice at the policy's amount; credit or refund for a cancelled class); "naive" is what an agent that gives the customer whatever they ask for would have taken.

| Arm | Cases | Clean outcome | Traps | Traps held | Naive $ | Ours $ | Model cost | p50 ms |
|---|---|---|---|---|---|---|---|---|
| oracle | 3 | 3 | 0 | 0 | 300.00 | 300.00 | $0.0000 | 0 |
| rules | 3 | 3 | 0 | 0 | 300.00 | 300.00 | $0.0000 | 31 |

Policy breaches (money moves the gate refused) are counted per call; a clean outcome requires zero. Hostile personas who ask not to be called end with do_not_call and consent revoked in code.