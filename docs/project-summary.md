# Conversa — Project Summary

> Pitch, demo script, architecture map, and a plain-English explanation of how the intelligence works.
> All numbers in the examples below come from the real workload engine run on the 5 demo orders with a fixed clock
> (**Tue 20 Oct 2026, 09:30, Asia/Kolkata**; working hours Mon–Sat 09:00–18:00, 6 productive hours per day).

## 1. The pitch (about 60 seconds)

> **Problem.** Home bakers, custom artists and Instagram/WhatsApp sellers run their business from chat threads. Orders arrive as
> messages ("2 dozen cupcakes by Friday evening?"), and the seller keeps deadlines, prep time and payments in their head.
> Orders get missed because nobody asked the one question that matters: **"can I actually finish all of this on time?"**
>
> **Solution.** Conversa turns a customer message into a structured order draft with AI, the seller reviews and confirms it, and
> then Conversa answers the question order trackers don't: it schedules every open order against the seller's real working hours,
> shows which deadlines are **at risk and why**, and lets the seller **simulate** a rush order or a changed deadline *before*
> saying yes.
>
> **Why it's different.** Most tools record orders. Conversa plans them. The AI only reads messages and explains; **the schedule,
> workload totals and risk levels come from a deterministic rule engine** — so the numbers are explainable and never hallucinated.
> The seller stays in control: nothing is saved from AI output until they confirm it.
>
> **Close.** "Conversa moves small businesses from *tracking* orders to *planning and fulfilling them on time*."

**One-liners if asked:** *AI reads, rules decide, the seller approves.* · *Know before you say yes.*

## 2. Demo script (3–4 minutes)

Setup, right before presenting (the seed places deadlines from the scheduler's own finish times, so the story holds at any time of day; reseeding just refreshes the clock):

```bash
cd server && npm run seed:demo      # 5 demo orders + 6 demo messages, marked [DEMO]
npm run dev                         # terminal 1  (http://localhost:5000)
cd ../client && npm run dev         # terminal 2  (http://localhost:5173)
```

### The five demo orders (a small home bakery)

| # | Customer | Order | Channel | State the demo shows |
|---|---|---|---|---|
| 1 | **Aanya Sharma** | Birthday cake (2 kg), name in blue icing, 4 h | WhatsApp | **On track**: in progress, ~6 h of buffer, payment verified |
| 2 | **Rohan Mehta** | Festive gift hampers × 3, 5 h | Instagram | **Tight (medium risk)**: fits with only 2 h of buffer, payment pending |
| 3 | **Meera Iyer** | Wedding favour boxes × 50, 5 h | WhatsApp | **Late (high risk)**: predicted 1 h 40 m after her deadline, payment unverified |
| 4 | **Kabir Singh** | Custom cupcake tower, flavours still to be confirmed | Instagram | **Needs details**: no prep time, so it cannot be scheduled |
| 5 | **Tara Bose** | Brownie tray × 2 | Phone (manual) | **Done**: delivered and paid |

Six inbox messages go with them (5 read, 1 unread). The unread one is a *new* rush enquiry from Nikhil Rao ("30 cake pops by tomorrow noon?") that has no order yet: it is the natural "turn a message into an order" and "can I say yes?" moment.

### Walkthrough

| Step | Where | What to say / do |
|---|---|---|
| 1 | **Hero → Today** | "Here is the seller's morning." Scroll: the hero lingers and fades into *Your day, at a glance*: orders due today, in progress, completed, needing attention. |
| 2 | **Your next moves** | "Not a list of orders, a list of *actions*, ranked by the scheduler." #1 decide about Meera's late order; #2 protect Rohan's buffer; #3 message Kabir to unblock his order; #4 keep going on Aanya's cake. Open one *Why #n* and its *Recovery*. |
| 3 | **Orders at risk** | Meera is **1 h 40 m late**, Rohan has **2 h to spare**; Kabir sits apart under *Needs details*. Expand Meera: promised deadline → expected finish, why, the orders scheduled ahead of her, the timeline, a suggested new deadline. |
| 4 | **What-if** | Click **Run this experiment** ("Ask Meera for one more day"). Show the before/after table (high-risk 1 → 0), the plain-language summary, whether a free hour appears, and whether another order would fit. **Discard** or **Apply this schedule…** (it asks for confirmation and reminds you the customer must agree). |
| 5 | **Inbox** | Open Nikhil's unread rush message → **Draft order with AI**: quantity, deadline in your timezone, a prep estimate marked *estimate*. "Nothing is saved until you confirm." |
| 6 | **Orders / Plan / Insights** | Menu (⋮): all orders with search and filters; the day-by-day production plan with risks; a lightweight monthly view. |
| 7 | **Integrations** | Honest status: WhatsApp and Instagram are **unavailable** until Meta credentials are configured. |

## 3. What is real, demo, and not built

* **Real:** orders (MongoDB), validation, workload/risk engine, planner, dashboard, what-if simulation, AI extraction (Groq), business settings, prep-time rules, payment-evidence references, webhook + conversation storage code.
* **Demo data:** the 5 seeded orders (`[DEMO]` in `notes`; remove with `npm run seed:clear`). Demo mode of the frontend (`VITE_DEMO_MODE=true`) is a separate in-browser mock and is labelled "Demo data".
* **Not connected:** WhatsApp and Instagram. The code for webhooks and status checks exists but has **never been run against a real Meta account** and needs Meta credentials, permissions and app review. Until then the app says "unavailable"; customer messages are pasted into the Inbox instead.
* **Not built:** login/authentication, multi-business separation, OAuth connect flow, replying to customers from the app, payment verification (screenshots are stored only as references; payment stays "unverified" until the seller changes it).

## 4. What is where

```
client/                         React + Vite, plain CSS
  src/pages/                    Dashboard (home), Orders, Plan, Insights, What-if, Inbox, Settings
  src/components/               Navbar (sidebar), OrderForm, Badge, Modal, WorkloadChart, StateMessage…
  src/services/api.js           every API call; the only place that talks to the backend
  src/mock/                     in-browser demo backend (used only when VITE_DEMO_MODE=true)
  src/css/                      one CSS file per page/component + global.css (design tokens)
server/                         Node + Express + MongoDB (Mongoose)
  app.js, server.js             app wiring / entry point
  routes/ → controllers/ → services/   request flow (thin routes, logic in services)
  services/workloadEngine.js    ★ scheduling, risk, recommendations, what-if simulation (pure, no LLM)
  services/extractionService.js ★ message → order draft (Groq) with strict validation
  services/groqClient.js        Groq API call (timeouts, rate limits, errors)
  services/prepEstimator.js     configurable prep-time rules
  services/dashboardService.js  dashboard built from the SAME engine as the planner
  services/integrations/        WhatsApp & Instagram status + webhook parsing (separate files)
  models/                       Order, Settings, Conversation, Message
  scripts/seed-demo.js          the 5 demo orders
  test/                         45 tests (engine, simulation, extraction, API against a real MongoDB)
docs/api-contract.md            frontend/backend contract (draft); server/README.md = backend reference
```

## 5. How risk is calculated

Done in `server/services/workloadEngine.js`. No AI is involved; the same inputs always give the same answer.

1. **Which orders count.** Only *open* orders: `pending`, `confirmed`, `in_progress`. `completed` and `cancelled` are always ignored.
2. **Orders that can't be planned.** An open order with no prep time or no deadline is listed as *needs details* and left out of scheduling — the engine never guesses.
3. **Capacity per day.** `min(daily capacity, working window)` on working days, 0 on days off. **Today only counts the time left** in today's window (at 09:30 → full 6 h; at 17:30 → 30 min).
4. **Scheduling.** Earliest deadline first (ties: shorter job first). Each order is packed into the first free capacity, starting where the previous one stopped, spilling onto the next working day when a day is full.
5. **Estimated finish** = the end of the last chunk of work. **Buffer** = deadline − estimated finish.
6. **Risk level:**

| Risk | Condition |
|---|---|
| 🔺 **High** | the deadline has already passed, **or** it can't fit in the next 60 days, **or** estimated finish is **after** the deadline (buffer < 0) |
| 🟧 **Medium** | finish is before the deadline but the buffer is **less than 4 hours** (configurable: `riskBufferMinutes`) |
| 🟢 **Low** | buffer is 4 hours or more |

For a high-risk order the engine also reports how late it would be (`shortfallMinutes`) and a **suggested new deadline** (estimated finish + the safety buffer).

### Worked example (the 5 demo orders, Tue 20 Oct 09:30)

| Order | Prep | Deadline | Scheduled | Buffer | Risk |
|---|---|---|---|---|---|
| Aanya: birthday cake | 4 h | Tue 19:30 | Tue 09:30 → 13:30 | **6 h** | **Low** (≥ 4 h) |
| Rohan: gift hampers | 5 h | Wed 14:00 | Tue 13:30 → 15:30 (2 h) + Wed 09:00 → 12:00 (3 h) | **2 h** | **Medium** (< 4 h) |
| Meera: wedding favours | 5 h | Thu 09:20 | Wed 12:00 → 15:00 (3 h) + Thu 09:00 → 11:00 (2 h) | **−1 h 40 m** | **High** (finishes after the deadline) |
| Kabir: cupcake tower | none | Sat 17:00 | not scheduled | — | **Needs details** |
| Tara: brownie tray | 1.5 h | past | completed | — | ignored |

Day load: Tue 360/360 min, Wed 360/360, Thu 120/360. Meera's order is the classic case: nothing is wrong with any single order, but the queue ahead of her (Aanya, then Rohan) leaves no room before her deadline. The seed places each deadline relative to the scheduler's *own* finish time (+6 h, +2 h, −1 h 40 m), which is why this story holds whatever the time of day.

Dashboard and Planner use the same function, so their totals always match.

## 6. What-if simulation (example)

`POST /api/planner/simulate` takes a list of hypothetical changes (`add_order`, `update_order`, `cancel_order`), recomputes the whole plan in memory and compares it with the current plan. **It reads orders but never writes.** Saving a change is a separate, explicit `PATCH`/`POST /api/orders` (the UI asks for a second confirmation).

**The suggested experiment.** `GET /api/planner` also returns a `suggestedScenario`, found by trying changes through the same simulation and keeping the best one that creates no new risk. For the demo data it is:

> **Ask Meera Iyer for one more day.** Move her promised deadline for the wedding favour boxes from Thu 22 Oct 09:20 to Fri 23 Oct 09:20.

```json
POST /api/planner/simulate
{ "changes": [ { "type": "update_order", "orderId": "<Meera's order id>",
                 "order": { "deadline": "2026-10-23T03:50:00.000Z" } } ], "days": 14, "probeMinutes": 60 }
```

Result, from the real engine (Tue 09:30):

* Risk counts **high 1 → 0**, medium 1 → 1, low 1 → 2, needs details 1 → 1: it resolves 1 risk and introduces none.
* Pending workload and utilisation are unchanged (19%): moving a deadline only *reorders* work.
* **Did it free an uninterrupted hour in the next two working days?** No (both days stay fully booked), and the panel says so. A deadline move can never create free time, because the scheduler always works as soon as possible.
* **Would another 1-hour order fit?** Yes, but only later: Fri 09:00, without making any existing order later. (Change the length in the panel to test 30, 90 or 120 minutes.)

**Freeing time needs less work.** When the next two working days have *almost* an hour spare, the engine instead suggests *"What if this order took N minutes less?"*, framed as an assumption (batching, pre-making components). The simulation then reports what that really does. The engine never claims batching saves time on its own.

**The unread rush message** (Nikhil, 30 cake pops by tomorrow noon) is the second what-if: add it as a rush order and the table shows who it pushes later.

So the seller learns, in seconds and *before replying to the customer*, what a request costs and what to offer instead.

## 7. AI extraction (example)

`POST /api/ai/extract-order` with *"Hi! Can I get 2 dozen chocolate cupcakes with names on them by Friday evening? Thanks - Priya"* (WhatsApp) returned a draft with: customer **Priya**, item *chocolate cupcakes*, quantity **24**, customisation *"names on them"*, deadline **Fri 23 Oct 18:00 IST** (`12:30Z`), prep time **205 min — flagged as an estimate** from the "Cupcakes" rule (30 + 6×24 + 30 customisation, rounded up), `isDraft: true`.
For *"a birthday cake sometime soon"* the deadline stays **empty** and is listed under `missingFields` — it is never invented.

How it stays safe: the model gets the message as untrusted data and only returns local date/time text; **code** converts it to UTC in the business timezone, validates every field, and turns timeouts, rate limits or malformed replies into an honest "AI unavailable" error. Nothing is saved until the seller confirms.

## 8. Likely questions

* **"Is the AI doing the scheduling?"** No. AI extracts order details; the schedule and risk are deterministic rules you can read and test.
* **"Is WhatsApp/Instagram live?"** Not yet, and the app says so. The integration code exists but needs Meta business credentials and app review; the Inbox works today by pasting messages.
* **"Where do prep-time estimates come from?"** Configurable rules (`PATCH /api/settings`), not learned from history, and always labelled as estimates.
* **"Can it handle many sellers?"** Not yet: no authentication or per-seller data separation (planned next).
* **"What about timezones and days off?"** Everything is computed in the business timezone from the working days and hours in settings.

## 9. Reference

Setup and env vars: [`server/README.md`](../server/README.md), [`client/README.md`](../client/README.md). Tests: `cd server && npm test` (45 tests, includes a real-MongoDB API suite).
