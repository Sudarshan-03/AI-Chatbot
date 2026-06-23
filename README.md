# 🏔️ North Star Support Bot

A customer-support chatbot for **North Star Outdoors** (simulated outdoor-apparel &
camping-gear e-commerce brand). Built as a freelance demo with a 24–48h SLA.

- **Frontend:** React (Vite) + Tailwind CSS
- **Backend:** Node.js + Express
- **State:** In-memory session FSM + Regex-based intent detection

---

## ✨ Features

| Use case | How it works |
|---|---|
| **Order Tracking** | Intent → FSM enters `AWAITING_ORDER_NUMBER` → DB lookup → reset to `IDLE` |
| **Returns & Exchanges** | Explains 30-day policy + returns link |
| **Product Recommendations** | 2 clarifying questions (activity → conditions) → category pick |
| **Human Handoff** | Explicit request **or** 2 consecutive fallbacks → `HUMAN_HANDOFF` state |

**Key architecture**
1. **Intent Dictionary** — Regex patterns (no naive string matching), e.g.
   `/(where\|track\|status).*(order\|package\|delivery)/i → ORDER_TRACKING`
2. **Session FSM** — in-memory `Map<sessionId, {state, fallbackCount, context}>`
3. **Graceful fallbacks** — polite in-brand nudge + Quick Replies; auto-handoff on repeat

---

## 🚀 Setup

```bash
# 1) Backend (terminal 1)
cd backend
npm install
npm start            # → http://localhost:3001

# 2) Frontend (terminal 2)
cd frontend
npm install
npm run dev          # → http://localhost:5173
```

Open **http://localhost:5173**. Try order numbers **111**, **222**, **333**.

---

## 🗂️ Project structure

```
AI ChatBot/
├── backend/
│   ├── package.json
│   └── server.js          # Express API + intent + FSM
└── frontend/
    ├── index.html
    ├── package.json
    ├── vite.config.js
    ├── tailwind.config.js
    ├── postcss.config.js
    └── src/
        ├── main.jsx
        ├── App.jsx         # chat UI + API wiring
        └── index.css       # Tailwind + animations
```

## 🧪 Try these

- `track my order` → `111` → Shipped, arriving tomorrow
- `return policy`
- `recommend gear` → `Hiking` → `Cold & snowy`
- type nonsense **twice** → automatic human handoff
