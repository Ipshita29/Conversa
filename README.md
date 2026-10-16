# Conversa — The Microbusiness Operations Copilot

> **Status:** Project concept and implementation plan. Features described below are planned unless explicitly marked as implemented in the repository.

Conversa is a proposed AI-powered assistant for small businesses that sell through WhatsApp and Instagram. It helps sellers turn customer conversations into structured orders, keep track of payments and deadlines, schedule preparation work, and understand their business without manually copying details between chats, notes, spreadsheets, and calendars.

## The problem

Small and home-based sellers often manage enquiries, order changes, payment evidence, pickup/delivery details, and follow-ups manually across social platforms. This can lead to missed orders, forgotten deadlines, delayed responses, and unclear payment status.

## Proposed solution

Conversa follows one simple workflow:

**Customer message → AI order draft → seller review → order/payment tracking → calendar → business insights**

AI should assist the seller, not silently make consequential decisions. Sellers approve order creation, changes to paid orders, payment status, and outbound messages.

## Planned MVP

- **Unified inbox:** organise supported customer conversations in one workspace.
- **AI conversation intelligence:** identify order intent and extract details such as product, quantity, deadline, and delivery/pickup preference.
- **Editable reply drafts:** suggest responses for the seller to review and send.
- **Order management:** track orders through Enquiry, Order Confirmed, Payment Pending, Payment Received, Preparing, Ready, Delivered, and Follow-up.
- **Order-change understanding:** interpret follow-up messages and help associate them with an existing order; show price/payment implications before applying changes.
- **Payment screenshot assistance:** extract candidate details from payment evidence for seller review. OCR/AI output is **not proof of payment**.
- **AI-assisted business calendar:** organise work using order deadlines, preparation time, priority, and delivery/pickup times.
- **Business dashboard:** summarise sales, orders, pending payments, upcoming deadlines, and simple trends.
- **Follow-up reminders:** suggest actions for unanswered enquiries, pending payments, pickups, feedback, and repeat customers.

## Suggested technology

| Layer | Proposed tools |
|---|---|
| Frontend | React, Vite, React Router, plain CSS, Lucide React |
| Backend | Node.js, Express |
| Database | MongoDB Atlas, Mongoose |
| AI | One LLM provider initially (for example, Gemini or OpenAI), called from the backend |
| Messaging | Official WhatsApp Business Platform Cloud API and Instagram Messaging API, subject to account eligibility and permissions |
| Optional live updates | Socket.IO |
| Scheduled reminders | Rule-based date/time logic; optionally `node-cron` |
| Deployment | Vercel (frontend), Render (backend), MongoDB Atlas (database) |
| Collaboration | Git and GitHub |

Keep the first version simple. A single backend and a focused AI service are sufficient; microservices, multi-agent orchestration, and a vector database are not required for the MVP.

## High-level architecture

1. A customer message arrives through an official platform webhook, or a sample message is used in demo mode.
2. The backend normalises the message and sends relevant content to the AI extraction service.
3. The AI returns structured candidate fields.
4. The backend validates the result against a schema.
5. The seller reviews and edits the proposed order or reply.
6. Once approved, the backend creates or updates the order.
7. Order status, payment review, calendar tasks, and dashboard summaries update.

Build a complete sample-data demo first. Real messaging integration may require business-account setup, permissions, app configuration, and webhook verification.

## Proposed data collections

- `users`
- `connectedAccounts`
- `customers`
- `conversations`
- `messages`
- `products`
- `orders`
- `payments`
- `tasks`

Never store API keys or access tokens in source control. Store integration credentials securely and keep them server-side.

## Order lifecycle

`Enquiry → Order Confirmed → Payment Pending → Payment Received → Preparing → Ready → Delivered → Follow-up`

The lifecycle may need to support cancellation, refunds, partial payments, or changes depending on the seller’s workflow. Record important changes in an order history.

## Safety, privacy, and reliability

- Treat AI output as a suggestion; validate it server-side and make it editable.
- Require explicit seller approval before sending consequential messages or applying high-impact order changes.
- Do not mark payments as received based only on screenshot OCR.
- Use official messaging APIs and follow their current terms, permission requirements, and messaging policies.
- Restrict each business to its own customer and order data.
- Protect credentials, encrypt stored integration tokens, validate webhooks, and avoid logging unnecessary private message content.
- Make demo/sample data clearly distinguishable from real connected-account data.
- Include clear loading, empty, error, and disconnected-account states.

## Getting started

This repository is currently a project plan. Once the frontend and backend have been scaffolded, update this section with the exact commands and environment variables used by the implementation.

A suggested repository structure:

```text
conversa/
├── client/                 # React + Vite frontend
├── server/                 # Express API and webhook handlers
├── docs/                   # Architecture and setup notes
├── .env.example            # Variable names only; no real secrets
├── .gitignore
├── LICENSE
└── README.md
```

Suggested implementation order:

1. Create the React dashboard and seed realistic sample conversations/orders.
2. Define and validate the message-to-order JSON schema.
3. Build the seller review and order creation workflow.
4. Add order statuses, payment review, change history, and calendar scheduling.
5. Add dashboard summaries and follow-up reminders.
6. Deploy and test the demo end to end.
7. Connect official WhatsApp/Instagram APIs where eligible and available.
8. Add automated tests, screenshots, a demo video, and deployment/setup instructions.

## CodeSprint 2026 context

The project was being considered for Elite Coders CodeSprint 2026. The official Devpost listing describes an online build phase from **15 October to 15 November 2026**, followed by a final pitch in Dehradun on **22 November 2026** for shortlisted teams. The listing states teams of 2–5 students and requires a public GitHub repository with an open-source licence. Check the official event pages for the latest requirements.

- Event: https://codesprint-by-elitecoders.devpost.com/
- Rules: https://codesprint-by-elitecoders.devpost.com/rules
- Unstop listing: https://unstop.com/hackathons/codesprint-2026-elite-coders-1761190

## Naming

**Conversa** is the current working name. Earlier mockup work used **ChatterCart** as a temporary dashboard label; that was a mockup name, not a confirmed final brand.

## Project status

The product scope, architecture, UI direction, and build plan are documented here. Do not describe a feature as implemented until it exists in the repository and has been tested.

## License

Choose and add an appropriate open-source licence before publishing. CodeSprint’s listed rules require a public GitHub repository with an open-source licence. Do not claim a licence until the `LICENSE` file is actually present.
