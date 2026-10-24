# Conversa

**Know before you say yes.** Conversa turns customer messages into orders, schedules them against a home baker's real working hours, and shows which deadlines are at risk and why.

> **AI reads. Rules decide. You approve.**
> The AI only drafts an order from a message. The schedule and the risk levels come from a deterministic rule engine, so they are explainable and never made up. Nothing is saved until you confirm it.

## What it does

| | |
|---|---|
| **Messages → orders** | Paste or receive a customer message; AI drafts the order, you review and confirm. |
| **Production plan** | A Kanban board that sorts every order into *Critical*, *Upcoming*, *Needs details* and *Completed*. |
| **Risk, explained** | Each at-risk order says why ("finishes 3h after the deadline, behind 2 earlier orders") and what to do. |
| **What-if** | Try a rush order, a new deadline or a shorter prep time first. Nothing is saved until you apply it. |
| **Insights** | Revenue, orders, top products and smart tips for the last 7 or 30 days. Real and demo orders are kept apart. |

## Try it in 1 minute (no database, no keys)

```bash
cd client
npm install
npm run dev        # open http://localhost:5173
```

This runs in **demo mode** with five sample bakery orders (on track, tight, late, needs details, done).

## Run the full stack

```bash
# 1. API  (needs MongoDB; add a Groq key for AI drafting)
cd server
cp .env.example .env      # set MONGODB_URI and GROQ_API_KEY
npm install
npm run seed:demo         # optional: load the sample bakery
npm run dev               # http://localhost:5000

# 2. App  (point it at the API)
cd ../client
cp .env.example .env      # set VITE_DEMO_MODE=false
npm install
npm run dev
```

Tests: `cd server && npm test`

## How it works

```
customer message ──AI──▶ order draft ──you confirm──▶ order
                                                       │
working hours + prep time + deadline ──rule engine──▶ schedule + risk + what-if
```

The scheduler works earliest-deadline-first inside your working hours and daily capacity, then compares each order's predicted finish with its promised deadline.

## Built with

React + Vite · Express · MongoDB · Groq (AI drafting) · Lenis (smooth scrolling) · plain CSS

## Honest limits

- WhatsApp and Instagram are **not connected**. Messages in the demo are stored samples. The webhook code is there, but it needs Meta credentials.
- Revenue is **booked sales** from the optional price you enter on an order, not money collected. Orders without a price are left out of revenue.
- Completion times aren't recorded, so on-time delivery rate can't be measured yet.

More detail: [`docs/project-summary.md`](docs/project-summary.md) (pitch and demo script) · [`docs/api-contract.md`](docs/api-contract.md) (API)
