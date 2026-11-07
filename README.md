# Tech WA Marketing

A self-hosted WhatsApp outreach tool. You link **your own number by scanning a QR code**
(the official WhatsApp multi-device link, same as WhatsApp Web) — **no paid Business API**,
no third-party gateway. Built around keeping the number healthy: paced sending, daily limits,
active-hours windows, gradual warm-up, message variation, and instant human-handoff on replies.

## What's inside

| Section | What it does |
|---|---|
| **Overview** | Live stats + active campaign progress + recent activity |
| **Contacts & Leads** | Add / bulk-import leads (paste a list), tag, filter, opt-out tracking |
| **Templates** | Messages with `{{first_name}}` variables and `{spin|text}` for variation |
| **Campaigns** | Target an audience by tag, set pace/window/limit, start & pause |
| **Conversations** | Inbox of replies, WhatsApp-style chat, resolve handoffs, reply manually |
| **WhatsApp Gateway** | Scan the QR to link your number; connection status |
| **Audit Logs** | Every send, reply, handoff and connection event |
| **Settings** | Pacing, window, warm-up curve and safety controls |
| **Authentication** | Workspace/account info |

## Requirements
- Node.js 18+ (tested on Node 24)
- A phone with WhatsApp installed (to scan the QR and keep online)
- **MongoDB** — stores **all** app data (accounts, contacts, templates, campaigns, messages, settings). Either:
  - **Local:** `brew tap mongodb/brew && brew install mongodb-community && brew services start mongodb-community`
  - **Cloud (Atlas, free):** create a cluster and set `MONGODB_URI` to its connection string.

## Accounts & login
The dashboard is protected by a login. On the **very first visit** you create the **owner**
account (name, email, password) — after that you sign in each time. Owners/admins can add team
members from the **Authentication** page. Passwords are bcrypt-hashed; the session is a signed,
http-only cookie. Everything is stored in MongoDB.

If MongoDB isn't running, the login screen says so and tells you how to start it.

### Environment variables (optional)
| Var | Default | Purpose |
|---|---|---|
| `MONGODB_URI` | `mongodb://127.0.0.1:27017` | MongoDB connection string (local or Atlas) |
| `MONGODB_DB` | `pulse_wa` | Database name |
| `JWT_SECRET` | auto-generated in `data/.jwt_secret` | Signs session cookies |
| `PORT` | `4000` | API/server port |

Example with Atlas:
```bash
MONGODB_URI="mongodb+srv://user:pass@cluster.mongodb.net" npm start
```

## Run it

First time only — install everything:
```bash
npm run setup
```

### Development (hot reload, two processes)
```bash
npm run dev
```
Open the **Vite** URL it prints (http://localhost:5173). The API runs on :4000 and is proxied.

### Production (one process)
```bash
npm run build     # builds the React app into web/dist
npm start         # serves UI + API together on http://localhost:4000
```

## Linking your WhatsApp
1. Open the app → **WhatsApp Gateway** → **Connect WhatsApp**.
2. On your phone: **WhatsApp → Settings → Linked Devices → Link a device**.
3. Scan the QR shown in the browser. Done — the paced sender takes over.

## How a campaign flows
1. **Contacts** → import/add leads (numbers must include the country code, e.g. `9230…`).
2. **Templates** → write a message; use spin text + `{{first_name}}` so no two sends match.
3. **Campaigns** → new campaign, pick a template + audience tag, set the pace, **Create**.
4. Press **Start**. The worker sends inside the window, waits a random gap between each,
   verifies the number is on WhatsApp first, and **stops the moment a lead replies** —
   that conversation moves to **Conversations** for a human.

## Staying un-banned (built in)
- Randomized delay between every message (default 35–90s).
- Daily cap + gradual warm-up (starts ~20/day, ramps up).
- Sends only inside your local active-hours window.
- Verifies each number exists on WhatsApp (avoids wasted/bounced sends).
- Message spin text → each recipient gets a slightly different message.
- Replies instantly pause automation; `stop`/`unsubscribe` auto opt-out.

> ⚠️ Unofficial automation always carries some risk. Use a number you can afford to lose,
> warm it up slowly, message people who expect to hear from you, and always offer an opt-out.

## Data
**All application data lives in MongoDB** — accounts, contacts, templates, campaigns, send queue,
messages, audit logs and settings (database `pulse_wa`). The only things stored locally in `data/`
are the encrypted WhatsApp session and the JWT signing secret. To reset the app completely, drop
the `pulse_wa` database (or delete its collections) and remove the `data/` folder.

## Tech
Node + Express + [Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web socket) +
**MongoDB** (all data) · JWT http-only cookie auth + bcrypt · React + Vite frontend ·
Server-Sent Events for live updates.
