---
name: callback
description: Operate Callback, the voice agent that makes a small business's money calls inside the owner's rules with PayPal doing the money. Use it to read today's plan, see why a customer is or is not being called, place or skip a call, read transcripts and traces, draft and backtest a call policy, and decide held money moves.
---

# Callback

Base URL: {APP_URL}

## What it is
Callback plans and makes a small business's money calls: confirm tomorrow's deposit, chase an overdue invoice, settle a cancelled class. It speaks inside the owner's written policy. Amounts come from the records; the brain only picks option ids (a discount step, an instalment plan, a callback slot). Consent, do-not-call and local calling hours are enforced in code before anything rings.

## Connect
- Owner tools: `POST {APP_URL}/mcp` with `Authorization: Bearer <owner key>` and `X-Agent-Id: <your name>` (MCP, stateless Streamable HTTP).
- Customer tools: `POST {APP_URL}/c/<token>/mcp` (the customer's own status link).
- Pages: `/today`, `/calls/:id`, `/policy`, `/ops/guard`, `/ops/eval`, `/ops/evidence`, `/trace/:id`.

## Owner tools
| Tool | Use it to |
|---|---|
| `get_plan` | See who would be called now and who is refused (consent, hours, attempts) with the reason and next window. |
| `list_calls`, `get_call` | Calls by status; one call with its transcript (quarantined lines marked) and state. |
| `place_call` | Place a planned call now. Consent and hours are re-checked in code; blocked stays blocked. |
| `skip_call` | Skip with a reason. |
| `list_customers` | Consent and do-not-call state. |
| `get_policy`, `list_policies`, `draft_policy` | Read the active rules; compile plain words to rules and see the 90-day backtest without activating. |
| `list_approvals`, `decide_approval` | Held money moves; approve or decline as the owner (large ones need the passkey on the Guard page). |
| `get_guard`, `get_trace`, `recent_events` | Kill switches, limits, audit chain; a run's step-by-step trace; the event feed. |

## Customer tools
`my_account`, `get_pay_link` (their own request: never held), `callback_slots`, `stop_calls` (revokes consent immediately).

## Rules an agent must respect
- Never ask Callback to call a customer without consent or outside 08:00–21:00 local: the code refuses and records it.
- Never pass amounts: there are no amount fields. Money is derived from the obligation; discounts and plans are policy options by id.
- A hold is not a failure: tell the owner what was held and why; `decide_approval` is their decision, not yours.
- Everything is traced: cite `/trace/<run_id>` when reporting what happened.
