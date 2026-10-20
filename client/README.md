# Conversa client

React + Vite + React Router, plain CSS. Follows the draft API in [`../docs/api-contract.md`](../docs/api-contract.md).

## Setup

```bash
cd client
npm install
cp .env.example .env   # optional; defaults match the values below
npm run dev            # http://localhost:5173
# To use the real backend (cd ../server && npm run dev), put VITE_DEMO_MODE=false in client/.env
npm run build          # production build into dist/
```

## Environment (public values only)

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | `http://localhost:5000/api` | Backend base URL |
| `VITE_DEMO_MODE` | `true` | `true`: serve simulated data from `src/mock/` (clearly labelled "Demo data"). `false`: call the real API |

In live mode (`VITE_DEMO_MODE=false`) a failed request is shown as an error; it is never replaced with mock data.

## Layout

- `src/services/api.js` — all API calls (one function per endpoint) and error handling
- `src/mock/` — demo backend: seed data, workload engine, in-memory route handler (matches the contract shapes)
- `src/pages/` — Dashboard, Orders, Inbox, Calendar (planner + simulation), Operations, Settings
- `src/components/`, `src/css/`, `src/hooks/`, `src/utils/` — shared UI, styles, helpers

## Known gaps

- `GET /api/conversations` is implemented by the server but not yet in `docs/api-contract.md`. Live conversations only appear once a Meta integration is configured and webhooks deliver messages.
- Replying to customers and connecting WhatsApp/Instagram are not implemented.
