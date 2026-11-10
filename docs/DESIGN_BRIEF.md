# Callback design brief

The old theme came from a kit shared with other projects. It is gone. Everything below comes from what Callback is: a phone line that carries money, run by rules the owner wrote.

## Three directions

**A. Carbon book.** The duplicate receipt book every clinic front desk has: cream paper, blue carbon ink, perforations, a red "HELD" rubber stamp. Type: a humanist serif for headings, typewriter mono for amounts. References: Field Notes, old bank passbooks. *Strength:* warm, trustworthy, money-native. *Weakness:* nostalgic; reads as accounting, not calling; mono amounts tire at small sizes.

**B. Switchboard.** The operator's board: each customer is a line with a lamp, a call is a patched line, and the board shows who is lit, who is waiting, who is barred. Lamps glow amber (ready), teal (on the line), burnt orange (needs you), green (settled) and are hollow red when a line is barred. Warm off-white panel by day, a dark lacquer panel by night. Type: an expanded grotesk for headings, a plain sans with tabular figures for everything else. References: Teenage Engineering's product pages, Braun panels, railway departure boards. *Strength:* the core screen (who to call today, who not, and why) *is* a switchboard; lamps give every money state one consistent shape. *Weakness:* risk of skeuomorphic kitsch if overdone.

**C. Clinic calm.** Sage and sand, rounded cards, appointment-card shapes, photography of studios. References: Headspace, Oura. *Strength:* matches the customer's own brand world. *Weakness:* indistinguishable from booking tools (Jane, Fresha) and from generic AI wellness sites; nothing in it says "money" or "rules".

| Criterion (1–5) | A Carbon book | B Switchboard | C Clinic calm |
|---|---|---|---|
| Comes from the product's own domain (calls + money + rules) | 3 | 5 | 2 |
| Makes the three jobs (who to call, the call, asks) easy to scan | 3 | 5 | 3 |
| Trust for a sceptical owner | 4 | 4 | 3 |
| Distinct from competitors and from generic AI sites | 4 | 5 | 1 |
| Legible on a phone between jobs | 3 | 4 | 4 |
| **Total** | 17 | **23** | 13 |

**Chosen: B, Switchboard**, kept restrained: lamps and lines are the only ornaments; everything else is plain type on a warm panel.

## Signature element: the three-lane call score

Every call is drawn as a score with three lanes, the trust pattern made literal:

- **Voice** (left): what the agent and the customer said, as a conversation.
- **Rules** (middle): each check code ran at that moment (consent, hours, gate decision, policy, limits), as a small labelled tick or bar.
- **Money** (right): each PayPal move, with its id, amount and status, drawn as a ticket stamped *allowed*, *held* or *refused*.

A thin vertical "line" runs through each lane; a money moment connects across all three. On a phone the lanes stack: the conversation with stamps inline. The same three lanes appear on the landing page ("AI proposes, code decides, PayPal moves") and in the approval sheet, so a judge sees one idea everywhere.

**Lamps** are the second, smaller motif: every call, customer and money move starts with a lamp. One shape, five states, never colour alone (each lamp has a text label and a distinct fill: solid, pulsing ring, ring, solid with tick, hollow).

## Typography

- **Display:** Archivo, variable, width 112–125 (expanded), weights 650–800. Headings, page titles, big numbers. ([Fontsource](https://fontsource.org/fonts/archivo), OFL)
- **Text:** IBM Plex Sans 400/500/600, chosen for clear small sizes and true tabular figures. ([Fontsource](https://fontsource.org/fonts/ibm-plex-sans), OFL). IBM Plex Mono only for ids and verify codes.
- Money, dates, times and statuses always use `font-variant-numeric: tabular-nums`.
- Scale (rem, 1.2 ratio from 1rem = 16px): 0.75 meta · 0.875 small · 1 body · 1.2 lead · 1.44 h3 · 1.728 h2 · 2.074 h1 · 2.986 display (landing only; clamps down on phones).
- Line length 60–72ch for prose; tables and the score are exempt. Body line-height 1.5; headings 1.1.

## Tokens

Colour (all pairs checked against WCAG 2.2 AA with `scratchpad/contrast.py`; every text colour is ≥ 5:1 on both background and surface):

| Token | Light | Dark | Use |
|---|---|---|---|
| `--paper` | #F4F1EA | #111311 | page background (the panel) |
| `--surface` | #FFFDF8 | #1A1D1A | cards, sheets |
| `--ink` | #1A1813 | #ECE8DE | text (15.7 : 1 / 15.3 : 1) |
| `--ink-2` | #57524A | #A9A497 | secondary text (6.9 / 7.5) |
| `--line` | #D9D1C1 | #2E322D | rules, borders |
| `--brand` | #0E5A53 | #5CC2B4 | switchboard teal: primary actions, links (7.1 / 8.7) |
| `--lamp-ready` | #9A5600 | #F2A93B | ready to call (5.0 / 9.3) |
| `--lamp-live` | #0B6E66 | #4FD1C0 | on the line (5.4 / 10.0) |
| `--lamp-hold` | #A13A12 | #FF8A5B | needs you / held (6.0 / 8.0) |
| `--lamp-done` | #2B6A33 | #7FCB86 | settled / allowed (5.8 / 9.6) |
| `--lamp-off` | #A3322A | #F07A70 | not calling / refused (6.1 / 6.9) |

Radius 6px (controls), 10px (cards), 999px (lamps, chips). Spacing 4px base: 4, 8, 12, 16, 24, 32, 48, 72. Elevation: one hairline border plus `0 1px 0` on cards; sheets and dialogs `0 12px 40px rgb(0 0 0 / .18)`. Motion: 120ms (press), 200ms (enter), 320ms (sheet); live lamps pulse at 1.6s. Under `prefers-reduced-motion` every animation and transition is off and live lamps show a static ring.

## Avoided on purpose

No purple-to-blue gradients, no glass panels, no bento grid, no emoji as icons (Lucide line icons only), no stock "trusted by" logos, no testimonials, no invented stats (every number on the landing page is either read live from the demo or labelled illustrative).

## Copy rules

Every screen answers three questions at the top: **what happened**, **what needs me**, **what happens next**. Sentences under 20 words. Money is always "$60.00 deposit for Priya, Thu 5 Mar 15:00", never "OBL-123". Status words are the same everywhere: *Ready*, *On the line*, *Needs you*, *Settled*, *Not calling*. Buttons say what they do ("Send $420 link", not "Approve"). An approval always says what moves, to whom, why it was held, and how to undo.

## Components

shadcn/ui (MIT) for the working app: sidebar, sheet, dialog, table, tabs, badge, tooltip, toast (sonner), command palette, skeleton, form controls, chart. As built: no Magic UI or Aceternity component earned its place. The landing page's count-up on the live owed total is a 20-line component of our own that respects reduced motion; adding a library for it would have cost more bundle than it gave. Every component is restyled to the tokens above. Guided tours: Driver.js (MIT).
