# Conversa server

Node.js + Express + MongoDB (Mongoose). ES modules. Implements the draft in [`../docs/api-contract.md`](../docs/api-contract.md);
differences and additions are listed under **Contract notes** below.

## Setup

```bash
cd server
npm install
cp .env.example .env     # fill in values; .env is git-ignored
npm run dev              # http://localhost:5000  (npm start for production)
npm test                 # unit tests + HTTP integration tests (see Testing)
```

Without `MONGODB_URI` the server still starts: `GET /api/health` works and database-backed routes answer `503 DB_UNAVAILABLE`.

## Environment variables (placeholders in `.env.example`)

| Variable | Needed for |
|---|---|
| `MONGODB_URI` | Everything except health/integrations status (MongoDB Atlas or local) |
| `CLIENT_ORIGIN` | CORS allow-list, comma-separated (default `http://localhost:5173`) |
| `BUSINESS_TIMEZONE` | Default IANA timezone (editable later via `PATCH /api/settings`) |
| `GROQ_API_KEY`, `GROQ_MODEL`, `GROQ_TIMEOUT_MS` | `POST /api/ai/extract-order`. Without a key it returns `503 AI_UNAVAILABLE` |
| `AI_RATE_LIMIT_PER_MINUTE` | Per-IP limit on the extraction endpoint (default 20) |
| `META_APP_SECRET` | Webhook signature verification (both channels) |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN` | WhatsApp Cloud API |
| `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_VERIFY_TOKEN` | Instagram messaging |
| `META_GRAPH_VERSION` | Graph API version (default `v21.0`) |

Secrets are read from the environment only, never returned by the API, and never logged.

## Endpoints

Errors always look like `{ "error": { "code", "message", "details?" } }`. Dates are ISO 8601; durations are minutes; list endpoints return `{ items, page, pageSize, total }`.

| Method & path | Notes |
|---|---|
| `GET /api/health` | `{ status: "ok", database: "connected" \| "disconnected" }` |
| `GET /api/dashboard` | stats, workload, urgent orders, upcoming deadlines, recommendations |
| `GET /api/orders` | filters `status` (comma list), `paymentStatus`, `source`; `page`, `pageSize` (≤100); `sort` = `deadline` (default, nulls last), `-deadline`, `createdAt`, `-createdAt`. Each order includes a computed read-only `risk` |
| `POST /api/orders` | 201. Required: `customerName`, `item`. Unknown or read-only fields → 422 |
| `GET /api/orders/:id` | 404 for unknown **or malformed** ids |
| `PATCH /api/orders/:id` | partial update; `completed`/`cancelled` are terminal (409 on status change) |
| `POST /api/orders/:id/payment-evidence` | **addition.** Stores a *reference* (URL/transaction id/note). Never changes `paymentStatus` |
| `POST /api/ai/extract-order` | body `{ message, source, customerName?, referenceTime? }` → `{ draft, missingFields, uncertainties, estimates, isDraft: true }`. **Saves nothing** |
| `GET /api/planner` | `days` (1–30, default 7), `from` (YYYY-MM-DD) |
| `POST /api/planner/simulate` | body `{ changes: [{ type, orderId?, order? }], days?, from? }`. **Read-only** |
| `GET /api/settings`, `PATCH /api/settings` | **addition.** `timezone`, `workingDays` (0=Sun), `workStart`, `workEnd`, `dailyCapacityMinutes`, `riskBufferMinutes`, `customisationMinutes`, `prepRules[]` |
| `GET /api/integrations` | per-channel status (see below) |
| `POST /api/integrations/:channel/connect` | `whatsapp` or `instagram`; re-verifies server credentials |
| `GET`/`POST /api/webhooks/:channel` | **addition.** Meta handshake and incoming messages |
| `GET /api/conversations` | **addition.** Conversations stored from webhooks (the shape the client Inbox expects) |

## Workload engine (deterministic, no LLM)

`services/workloadEngine.js` is pure and shared by the dashboard, planner and simulation. Assumptions:

1. Only open orders (`pending`, `confirmed`, `in_progress`) count; `completed`/`cancelled` are always excluded.
2. Pending workload = sum of `prepTimeMinutes` of open orders that have one. `prepTimeMinutes` is the **total for the order** (quantity is not multiplied).
3. Orders missing a prep time and/or deadline are reported in `unscheduledOrders`, never guessed.
4. Daily capacity = `min(dailyCapacityMinutes, working window)` on working days, 0 otherwise. **Today's capacity is limited to the time left in today's window**, so "available" shrinks through the day.
5. Earliest-deadline-first (ties: shorter job, then id), packed from the start of each day's window, spilling to the next working day. Breaks are not modelled. Everything is evaluated in the business timezone.
6. Risk: **high** = deadline passed, doesn't fit in the next 60 days, or estimated finish is after the deadline (`shortfallMinutes` + a `suggestedDeadline` are returned); **medium** = finish within `riskBufferMinutes` of the deadline; **low** otherwise.
7. `utilisationPercent` compares *all* pending minutes with capacity in the requested range, so it can exceed 100.

Scheduled start/end are computed on read (`planner.schedule[]`), not stored. Recommendations are rule-based text.

## AI extraction

The customer message is sent to Groq (`/openai/v1/chat/completions`, JSON mode) as delimited, untrusted data. The model returns local date/time strings only; **code** converts them to UTC in the business timezone. The output is strictly validated; anything malformed, a timeout, a rate limit (429) or a missing key becomes `503 AI_UNAVAILABLE` (never a made-up draft). Ambiguous deadlines are left `null`; a date with no time is flagged as assumed end of working day; past dates are rejected. Prep time comes from the configurable rules in settings (default rules are developer-chosen starting points, **not learned from history**) and is labelled in `estimates`.

## Integrations (WhatsApp Cloud API, Instagram)

* Status is `connected` **only** after a live credential check against the Graph API succeeds; otherwise `unavailable` with the missing variable *names* (never values). There is no `demo` or fabricated state. `disconnected` is unused.
* **No OAuth / Embedded Signup flow is implemented.** Credentials are supplied via environment variables, and `connect` simply re-verifies them (`200 { status: "connected", authorizationUrl: null }` or `503 INTEGRATION_UNAVAILABLE`).
* Webhooks: `GET` answers Meta's `hub.*` handshake; `POST` verifies `X-Hub-Signature-256` over the **raw body** with `META_APP_SECRET` (401 if wrong, 503 if no secret is configured). Messages are stored (conversation + message); a unique `(channel, externalId)` index makes retries idempotent. Storing a message does **not** create an order or call the LLM; the seller triggers extraction.
* Webhook payload shapes and the signature scheme were checked against Meta's current documentation. **The flows have not been run against a real Meta account**, and Instagram messaging requires a professional account, app permissions and Meta app review. Register `https://<host>/api/webhooks/whatsapp` and `/api/webhooks/instagram` in the Meta app dashboard with the matching verify tokens.

## Security notes

CORS limited to `CLIENT_ORIGIN`; 256 KB body limit; inputs validated and filters built only from validated enums (Mongo operators in queries are rejected); central error handler hides internals; request bodies and tokens are not logged. **Not implemented:** authentication, authorisation, and multi-business (tenant) isolation. This is a single-business backend and must not be exposed publicly as-is.

## Testing

`npm test` runs `node --test`: unit tests for the engine, simulation, timezones, validation, extraction (with stubbed Groq/Meta), signatures and webhook parsing, plus HTTP integration tests that start a throwaway local `mongod` (they are skipped, and reported as skipped, if `mongod` is not installed). No test calls Groq or Meta for real.

## Contract notes (for frontend/backend agreement)

Additive to `docs/api-contract.md` (the contract file itself was not edited): order fields `customerContact`, `customisation`, `notes`, `paymentEvidence[]`; workload `pendingHours`/`availableHours`; planner `schedule[]`, `overloadedDays`, risk `bufferMinutes`/`shortfallMinutes`/`suggestedDeadline`; simulation `comparison.{currentWorkload, simulatedWorkload, conflicts, overloadedDays, suggestedAdjustments}`; extraction `estimates`, `draft.{customisation, notes}`; error codes `DB_UNAVAILABLE`, `RATE_LIMITED`, `PAYLOAD_TOO_LARGE`, `INVALID_SIGNATURE`, `FORBIDDEN`; routes under *Endpoints* marked **addition**.
Differences: validation errors on bodies are 422 and on query strings 400; the connect flow differs from the contract's `authorizationUrl` example (see Integrations); working hours/capacity are now defined by `/api/settings` (contract open question #2).
The client Inbox needs `GET /api/conversations`, which should be added to the contract.
