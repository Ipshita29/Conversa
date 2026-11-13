# Conversa production setup: WhatsApp + Instagram

This is the checklist for taking Conversa from the built-in demo to real customer conversations. Nothing here is "live" until you have completed the Meta
steps in section 2 and the webhook check in section 4. Conversa never shows an account as connected until Meta itself has accepted its credentials.

## 1. Hosting

| Piece | Where | Why |
|---|---|---|
| Web app (`client/`) | Vercel, Render static site, Netlify, Cloudflare Pages | static files; `client/vercel.json` adds the SPA fallback |
| API (`server/`) | **An always-on host**: Render (see `render.yaml`), Railway, Fly.io, a VPS, or any Docker host (`server/Dockerfile`) | Webhooks must be answered quickly and pictures / payment screenshots are processed in the background and stored on disk. **Vercel serverless functions are not suitable for the API**: background work stops when the response is sent, and the filesystem is not persistent. |
| Database | MongoDB Atlas (any plan) | |
| Images | a persistent disk mounted on the API host (`PAYMENT_PROOF_DIR`, default `server/storage/proofs`) | files are stored under random names, never served as static files, and only through authenticated-by-obscurity API routes. If you move to a host without a persistent disk, put an object store behind `services/proofStore.js` first. |

HTTPS is required by Meta for webhooks and OAuth redirects; every host above provides it. The API sets HSTS in production.

**Access control.** Conversa has a single business owner and no login screen. Put the web app and the API behind your host's access control (for
example Cloudflare Access or HTTP basic auth at the proxy) before real customer data is in it. Meta's webhook route is the one public endpoint, and it
is protected by the X-Hub-Signature-256 check.

## 2. Meta setup (what only you can do)

Create one app at <https://developers.facebook.com/apps> (type **Business**). Use Graph API **v26.0** (the current release).

### WhatsApp
1. Add the **WhatsApp** product. You need a WhatsApp Business Account and a phone number that is not on the regular WhatsApp app.
2. Create a **Facebook Login for Business** configuration for *WhatsApp Embedded Signup* and copy its id into `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID`.
3. Add your web app's domain to **Allowed domains** and the app's **Valid OAuth redirect URIs**.
4. Permissions: `whatsapp_business_messaging`, `whatsapp_business_management`. Serving other businesses needs **business verification** and **app review (Advanced Access)**; for your own number you can work with Standard Access while testing.
5. Webhooks > WhatsApp Business Account: callback URL `SERVER_URL/api/webhooks/whatsapp`, verify token = `META_WEBHOOK_VERIFY_TOKEN`, subscribe to **messages**.
6. Message rules: free-form replies are allowed for **24 hours after the customer's last message**. After that WhatsApp requires an approved *message template*. Conversa refuses an out-of-window reply with a clear explanation instead of letting Meta reject it; it does not send templates yet.

### Instagram
Apps created recently only offer **"API setup with Unified login"** (Facebook Login for Business). Conversa supports it and the older Instagram Login; the mode follows which variables you set.
1. The account must be an Instagram **professional** account (business or creator) and be shared with your Meta business portfolio during login. A personal account cannot use the messaging API.
2. Meta app > Instagram > **API setup with Unified login**: create/choose the login **configuration**, make sure it grants `instagram_manage_messages` (and `instagram_basic`), and copy its **configuration id** into `INSTAGRAM_LOGIN_CONFIG_ID`.
3. In that configuration (and Facebook Login for Business settings) add the exact redirect URI `SERVER_URL/api/integrations/instagram/oauth/callback` under **Valid OAuth redirect URIs**.
4. Webhooks > Instagram: callback `SERVER_URL/api/webhooks/instagram`, verify token = `META_WEBHOOK_VERIFY_TOKEN`, fields **messages** and **messaging_seen**. Connecting from Settings also subscribes the chosen account to this app (a separate step Meta requires for every account).
5. While the app is in development mode only people with a role on the app (Instagram Tester) can connect. Serving accounts you do not own needs **Advanced Access (app review)**.
6. Replies are allowed within 24 hours of the customer's last message. A dead or revoked token shows as *Needs attention* in Settings with the reason.

Older apps that still have **Instagram Login** leave `INSTAGRAM_LOGIN_CONFIG_ID` empty and use `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` (a different pair from the Meta app's). That mode talks to graph.instagram.com, uses Instagram's own OAuth and renews its 60-day token automatically.

## 3. Environment variables

Backend (set on the API host; see `server/.env.example`):

| Variable | Needed for |
|---|---|
| `NODE_ENV=production`, `SERVER_URL`, `CLIENT_URL`, `MONGODB_URI` | the server refuses to start in production without MONGODB_URI and CLIENT_URL |
| `ENCRYPTION_KEY` (32+ chars) | storing connected-account tokens encrypted; **keep it safe**, changing it disconnects accounts |
| `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_GRAPH_API_VERSION` | webhooks (signature + handshake) and Meta sign-in |
| `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` | "Connect WhatsApp" in Settings |
| `GROQ_API_KEY` (+ `GROQ_MODEL`, `GROQ_VISION_MODEL`) | reading orders and payment screenshots |
| `PAYMENT_PROOF_DIR` | persistent location of customer pictures |
| `INSTAGRAM_LOGIN_CONFIG_ID` (Unified Login) or `INSTAGRAM_APP_ID` + `INSTAGRAM_APP_SECRET` (Instagram Login) | "Connect Instagram" in Settings |
| optional: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_ACCESS_TOKEN`, `INSTAGRAM_BUSINESS_ACCOUNT_ID`, `INSTAGRAM_ACCESS_TOKEN` | a single account configured by environment instead of Meta sign-in |

Frontend (set at build time; public values only): `VITE_DEMO_MODE=false`, `VITE_API_BASE_URL=https://api.yourdomain.com/api`.

Never commit `.env` files (they are git-ignored). Secrets are never sent to the browser and never written to logs (`server/utils/log.js` redacts them).

## 4. Connect and verify

1. Deploy the API, open `SERVER_URL/api/health` (expect `{"status":"ok","database":"connected"}`).
2. Register the webhook URLs in Meta. Meta's "Verify and save" calls the GET handshake; it succeeds only when `META_WEBHOOK_VERIFY_TOKEN` matches.
3. Deploy the web app with `VITE_DEMO_MODE=false`. In **Settings** the exact webhook and redirect addresses are shown with copy buttons.
4. Settings > **Connect WhatsApp** (Embedded Signup popup) and **Connect Instagram** (Instagram login). Each card moves through Not connected > Connecting > Connected, or Needs attention / Expired with the reason.
5. Send a message from a customer phone / account. It appears in **Messages** within seconds, labelled with its channel.

## 5. How the pieces behave

* **Webhooks** (`/api/webhooks/whatsapp|instagram`): signature verified over the raw body before anything is parsed; duplicate deliveries (Meta retries) are ignored via a unique `(channel, externalId)` index; unknown events are accepted and ignored; delivery/read receipts update the message that was sent.
* **Orders from conversations**: "Extract order" reads all the customer's messages together into one editable draft with the detected intent and missing details; prices and deadlines are never invented. Confirming creates exactly one order, linked to the conversation (a double click, retry or parallel request cannot create a second).
* **Payments**: a screenshot is stored as received, read by the vision model, attached to the conversation's order as *awaiting verification*, and never marked paid until you verify it. The same transaction never makes a second record.
* **Demo vs real**: demo records are flagged and never mixed. Orders, Messages, Payments and the Plan each show one data set (a Real | Demo switch appears only when both exist). Connecting an account never deletes or alters demo data, and the app does not switch to real data by itself until real records exist.
* **Tokens**: connected-account tokens are encrypted (AES-256-GCM) in MongoDB. Instagram tokens (60 days) are renewed automatically; a refused or expired token shows as Needs attention / Expired.

## 6. Tests

`cd server && npm test` runs the whole suite, including `test/integrations.test.js` which covers signed webhooks, duplicate deliveries, WhatsApp and Instagram messages, pictures without credentials, delivery receipts, one-order-per-conversation, payment screenshots, replies inside and outside the 24-hour window, the missing-credentials case, demo/real separation, OAuth and token refresh, all against a fake Meta (no network).
