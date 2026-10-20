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

Setup, right before presenting (deadlines are relative to "now", so reseed each time):

```bash
cd server && npm run seed:demo      # 5 demo orders, marked "[DEMO]" in notes
npm run dev                         # terminal 1  (http://localhost:5000)
cd ../client && npm run dev         # terminal 2  (http://localhost:5173)
```

| Step | Page | What to say / do |
|---|---|---|
| 1 | **Dashboard** | "Here's the seller's morning: 5 orders, workload vs available hours, and *Next actions* ranked by urgency." Point at the at-risk count and the workload chart. |
| 2 | **Inbox** | Paste: *"Hi! Can I get 2 dozen chocolate cupcakes with names on them by Friday evening? - Priya"* → **Extract order details**. Show the draft: quantity 24, deadline Fri 18:00, prep time *marked as an estimate*, and highlighted uncertainties. "Nothing is saved yet — the seller confirms." Click **Confirm & create order**. |
| 3 | **Orders** | The new order is in the list. Show search/filter, an inline status change, and the risk badge per order. |
| 4 | **Calendar** | The day-by-day plan: each order scheduled into real capacity; Rohan's hamper is flagged. Then **What-if simulation**: add a rush order due tomorrow 12:00 → show the red "new risks" and the suggested new deadline. Click **Discard** — "nothing changed". |
| 5 | **Operations** | Priority queue, deadline conflicts with reasons, recommended actions ("Prioritise…", "Add a preparation time…", "Confirm payment…"). |
| 6 | **Settings** | Honest integration status: WhatsApp / Instagram are **unavailable** until Meta credentials are configured. |

## 3. What is real, demo, and not built

* **Real:** orders (MongoDB), validation, workload/risk engine, planner, dashboard, what-if simulation, AI extraction (Groq), business settings, prep-time rules, payment-evidence references, webhook + conversation storage code.
* **Demo data:** the 5 seeded orders (`[DEMO]` in `notes`; remove with `npm run seed:clear`). Demo mode of the frontend (`VITE_DEMO_MODE=true`) is a separate in-browser mock and is labelled "Demo data".
* **Not connected:** WhatsApp and Instagram. The code for webhooks and status checks exists but has **never been run against a real Meta account** and needs Meta credentials, permissions and app review. Until then the app says "unavailable"; customer messages are pasted into the Inbox instead.
* **Not built:** login/authentication, multi-business separation, OAuth connect flow, replying to customers from the app, payment verification (screenshots are stored only as references; payment stays "unverified" until the seller changes it).

## 4. What is where

```
client/                         React + Vite, plain CSS
  src/pages/                    Dashboard, Orders, Inbox, Calendar (planner + simulation), Operations, Settings
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

### Worked example (the 5 demo orders, Tue 09:30)

| Order | Prep | Deadline | Scheduled | Buffer | Risk |
|---|---|---|---|---|---|
| Aanya – birthday cake | 4 h | Wed 17:00 | Tue 09:30 → 13:30 | 27.5 h | **Low** |
| Rohan – gift hampers | 7 h | Wed 17:00 | Tue 13:30–15:30 (2 h) + Wed 09:00–14:00 (5 h) | **3 h** | **Medium** (< 4 h) |
| Priya – cupcake box | 3 h | Fri 12:00 | Wed 14:00–15:00 + Thu 09:00–11:00 | 25 h | **Low** |
| Kabir – portrait | — | Sat 17:00 | not scheduled | — | **Needs prep time** |
| Tara – sketch | — | — | completed | — | ignored |

Day load: Tue 360/360 min, Wed 360/360, Thu 120/360. Rohan's order is exactly the "looks fine on a calendar but has no breathing room" situation Conversa exists to catch. Run the same data at 15:00 and Rohan turns **High**, because less of today is left.

Dashboard and Planner use the same function, so their totals always match.

## 6. What-if simulation (example)

`POST /api/planner/simulate` takes a list of hypothetical changes (`add_order`, `update_order`, `cancel_order`), recomputes the whole plan in memory and compares it with the current plan. **It reads orders but never writes.** Saving a change is a separate, explicit `POST`/`PATCH /api/orders` (the UI asks for a second confirmation).

**Question:** *"A customer wants 30 cake pops (4 h of prep) by tomorrow 12:00. Can I say yes?"*

```json
POST /api/planner/simulate
{ "changes": [ { "type": "add_order", "order": {
    "customerName": "Rush Customer", "item": "Cake pops", "quantity": 30,
    "prepTimeMinutes": 240, "deadline": "2026-10-21T06:30:00.000Z" } } ] }
```

Result (abridged, from the real engine):

* Pending workload **+240 min**; utilisation of the next 3 days **78% → 100%**.
* The new order itself fits (it is earliest-deadline, so it is scheduled first)…
* …but it **pushes Rohan's hampers from Medium to High**: *"Estimated to finish 19h after the deadline (Thu 22 Oct, 12:00)."*
* **Suggested adjustment** (`extend_deadline`): *"Moving its deadline to Thu 22 Oct, 16:00 restores a safe buffer."*

**Second question:** *"What if I ask Rohan to accept Thursday 17:00 instead?"* → `update_order` with the new deadline → Rohan's risk is **resolved** and no new risks appear.

So the seller learns, in seconds and *before replying to the customer*, that the rush order costs them another customer's deadline — and what to offer instead.

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
