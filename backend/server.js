/**
 * ============================================================================
 *  NORTH STAR OUTDOORS — SUPPORT BOT BACKEND  (HARDENED)
 *  Node.js + Express
 * ----------------------------------------------------------------------------
 *  Capabilities
 *    1. Intent Dictionary   → Regex intent detection (EN + ES, no naive match)
 *    2. Session FSM         → In-memory per-user state machine
 *    3. Graceful fallbacks  → In-brand replies + 2-strike escalation (EVERY state)
 *    4. Escape hatch        → Global escape-phrase check so NO state is absorbing
 *
 *  HARDENING APPLIED (see SECURITY.md for the full mapping)
 *    [1.1] FSM black-hole trap     → escape check hoisted to top of processMessage
 *                                    + 2-strike escalation now fires from sub-states
 *    [1.2] Memory exhaustion       → session TTL + bounded LRU store + periodic sweeper
 *    [3.1] ReDoS (analogue)        → 500-char input cap; all regexes linear (verified)
 *    [4.3] Context bleed           → HMAC-signed session tokens (clients can't forge ids)
 *    [4.4] CSWSH (analogue)        → CORS locked to a single allowed origin
 *    [5.1] Code-switching          → Spanish intent synonyms added (NA audience)
 *    [5.2] Entity extraction       → priority order-number extractor (no false grabs)
 *
 *  Every chat turn returns a JSON envelope:
 *    { sessionId (signed token), reply, options, sessionState }
 * ============================================================================
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;

// --- HARDENING CONFIG --------------------------------------------------------

// [4.4] CORS locked to the frontend origin only (the HTTP analogue of a
// WebSocket Same-Origin restriction). Drive-by sites can no longer POST to our
// endpoints on a victim's behalf.
const ALLOWED_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';

// [4.3] Secret used to sign session tokens. In dev we fall back to a random
// per-process value (in-memory sessions are wiped on restart anyway, so this is
// safe). In prod, set SESSION_SECRET in the environment.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SIG_LEN = 16; // hex chars of HMAC included in the token

// [1.2] Session store bounds. A real DB would handle this; in-memory we bound it.
const SESSION_TTL_MS = 30 * 60 * 1000;        // 30 min idle → expire
const SESSION_MAX = 1000;                      // hard cap on live sessions
const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // purge every 5 min

// [3.1] ReDoS analogue — cap user input so pathological strings can't be fed to
// the intent regexes (which are themselves linear / nested-quantifier-free).
const MAX_MESSAGE_LENGTH = 500;

// --- Global middleware -------------------------------------------------------
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

/* ============================================================================
 * 1. MOCK DATA  (our simulated "database" — there is no real DB)
 * ============================================================================
 *  Order #111 → Shipped, arriving tomorrow
 *  Order #222 → Processing, ships in 24 hours
 *  Order #333 → Delivered (ask a follow-up)
 *  Anything else → Invalid
 *  Returns: 30 days, unused, original packaging
 *  Shipping: Standard 3-5 days, Expedited 1-2 days
 * ========================================================================== */
const ORDERS = {
  '111': { status: 'Shipped',    detail: 'shipped and arriving tomorrow' },
  '222': { status: 'Processing', detail: 'being processed and ships within 24 hours' },
  '333': { status: 'Delivered',  detail: 'delivered' },
};

const RETURN_POLICY = {
  window: '30 days',
  condition: 'unused and in their original packaging',
  link: 'https://northstaroutdoors.com/returns',
};

const SHIPPING_INFO = {
  standard:  '3-5 business days',
  expedited: '1-2 business days',
};

/* ============================================================================
 * 2. INTENT DICTIONARY  (Regex-based, EN + ES)
 * ============================================================================
 *  Iterated in order; FIRST match wins → specific intents before generic ones.
 *
 *  [5.1] Code-switching: Spanish synonyms are folded in (the North American
 *  audience's primary second language). We use character classes like d[oó]nde
 *  and env[ií]o so BOTH accented and unaccented typing match. \b boundaries are
 *  only asserted at the ENDS of each alternation group, so accented characters
 *  inside a token never break the boundary check.
 *
 *  ReDoS note: every pattern here is LINEAR — there are no nested quantifiers
 *  (no (a+)+ style constructs), so catastrophic backtracking cannot occur on
 *  any input. Combined with the 500-char cap, the regex layer is ReDoS-safe.
 * ========================================================================== */
const INTENT_DICTIONARY = [
  {
    name: 'ORDER_TRACKING',
    // EN: "track my order", "where is my package", "delivery status"
    // ES: "¿dónde está mi pedido?", "rastrear mi envío", "cuándo llega"
    pattern: /\b(where|track|tracking|status|locate|find|when|rastrear|estado|cu[aá]ndo)\b.*\b(order|package|delivery|shipment|parcel|pedido|paquete|env[ií]o|entrega)\b|\btrack (my )?order\b|\bd[oó]nde est[aá] (mi|el) (pedido|paquete|env[ií]o)\b/i,
  },
  {
    name: 'RETURN_EXCHANGE',
    // EN: "return policy", "how do I return", "exchange", "refund"
    // ES: "devolver", "reembolso", "cambio", "política de devoluciones"
    pattern: /\b(return|returns|exchange|refund|devolver|devolucion|devoluci[oó]n|reembolso|cambio)\b.*\b(policy|item|gear|jacket|how|can i|pol[ií]tica|art[ií]culo|c[oó]mo)\b|return policy|exchange policy|pol[ií]tica de devoluciones/i,
  },
  {
    name: 'PRODUCT_RECOMMENDATION',
    // EN: "recommend gear", "what should I buy", "best tent"
    // ES: "recomienda", "sugiere", "qué equipo necesito"
    pattern: /\b(recommend|suggest|recomienda|recomendar|sugiere|sugerir)\b|\b(what|qu[eé]).*(gear|should|buy|need|equipo|necesito|comprar)\b|\bbest .*(for|gear|para)\b/i,
  },
  {
    name: 'SHIPPING_INFO',
    // EN: "how long does shipping take", "expedited"
    // ES: "tiempo de entrega", "cuánto tarda el envío"
    pattern: /\b(shipping|delivery time|how long|expedited|env[ií]o|entrega|cu[aá]nto tarda|tiempo de entrega)\b/i,
  },
  {
    name: 'HUMAN_HANDOFF',
    // EN: "talk to a human", "live agent", "real person"
    // ES: "humano", "agente", "atención al cliente"
    pattern: /\b(human|agent|representative|real person|humano|agente|persona real|representante)\b|\b(talk to|hablar con).*(someone|human|agent|alguien|humano|agente)\b|support team|customer service|atenci[oó]n al cliente/i,
  },
  {
    name: 'GREETING',
    // EN: "hi", "hello", "hey", "howdy"
    // ES: "hola", "buenos días", "buenas tardes"
    pattern: /\b(hi|hii|hello+|hey+|howdy|greetings|hola|holaa|buenos d[ií]as|buenas tardes|buenas noches)\b/i,
  },
  {
    name: 'THANKS',
    // EN: "thanks", "thank you", "thx"
    // ES: "gracias", "muchas gracias"
    pattern: /\b(thanks|thank you|thx|appreciate|cheers|ty|gracias|muchas gracias)\b/i,
  },
];

/**
 * Run the user's message through the Intent Dictionary.
 * @param {string} text - raw user input
 * @returns {string|null} an intent label, or null if nothing matched (→ fallback)
 */
function detectIntent(text) {
  for (const { name, pattern } of INTENT_DICTIONARY) {
    if (pattern.test(text)) return name;
  }
  return null;
}

/* ============================================================================
 * 2b. ESCAPE HATCH (fixes the FSM black-hole trap, [1.1])
 * ============================================================================
 *  Matches the natural ways a user asks to leave ANY flow — English + Spanish.
 *  This is checked at the TOP of processMessage so it fires in EVERY state,
 *  guaranteeing no FSM node can ever become an absorbing "black hole".
 * ========================================================================== */
const ESCAPE_PHRASES = /start (again|over)|restart|reset|main menu|exit|cancel|leave|go back|empezar|reiniciar|salir|cancelar|men[uú] principal/i;

/* ============================================================================
 * 3. SESSION STORE  (in-memory, BOUNDED + TTL — fixes [1.2])
 * ============================================================================
 *  sessions = Map<rawId, session>
 *
 *  session = {
 *    id,                 // rawId (the Map key; never sent to the client raw)
 *    state,              // current FSM node
 *    fallbackCount,      // consecutive unrecognised turns (drives escalation)
 *    context,            // scratch (recommendation activity/condition)
 *    createdAt, updatedAt,
 *  }
 * ========================================================================== */
const STATES = {
  IDLE: 'IDLE',
  AWAITING_ORDER_NUMBER: 'AWAITING_ORDER_NUMBER',
  AWAITING_REC_ACTIVITY: 'AWAITING_REC_ACTIVITY',
  AWAITING_REC_CONDITION: 'AWAITING_REC_CONDITION',
  HUMAN_HANDOFF: 'HUMAN_HANDOFF',
};

const sessions = new Map();

/**
 * Get-or-create a session, applying TTL expiry and the bounded-store cap.
 * @param {string} rawId - the unsigned Map key (NEVER the client-facing token)
 */
function getSession(rawId) {
  const now = Date.now();

  if (sessions.has(rawId)) {
    const existing = sessions.get(rawId);
    // Expired by inactivity → wipe to a clean IDLE but keep the slot.
    if (now - existing.updatedAt > SESSION_TTL_MS) {
      existing.state = STATES.IDLE;
      existing.fallbackCount = 0;
      existing.context = {};
    }
    existing.updatedAt = now; // refresh liveness on every access
    return existing;
  }

  // New session — enforce the hard cap by evicting the least-recently-active.
  if (sessions.size >= SESSION_MAX) evictOldest();

  const session = {
    id: rawId,
    state: STATES.IDLE,
    fallbackCount: 0,
    context: {},
    createdAt: now,
    updatedAt: now,
  };
  sessions.set(rawId, session);
  return session;
}

/** Remove the session with the oldest updatedAt (bounded LRU eviction). */
function evictOldest() {
  let oldestId = null;
  let oldestTime = Infinity;
  for (const [sid, s] of sessions) {
    if (s.updatedAt < oldestTime) {
      oldestTime = s.updatedAt;
      oldestId = sid;
    }
  }
  if (oldestId) sessions.delete(oldestId);
}

/**
 * Hard-reset a session to a clean IDLE. Used by the global escape hatch and by
 * POST /api/reset.
 */
function resetSession(rawId) {
  const session = getSession(rawId);
  session.state = STATES.IDLE;
  session.fallbackCount = 0;
  session.context = {};
  return session;
}

/**
 * Background sweeper — purges sessions idle longer than the TTL so the store
 * cannot grow unbounded over the process lifetime. .unref() lets the process
 * exit cleanly even though the interval is scheduled.
 */
setInterval(() => {
  const now = Date.now();
  let purged = 0;
  for (const [sid, s] of sessions) {
    if (now - s.updatedAt > SESSION_TTL_MS) {
      sessions.delete(sid);
      purged += 1;
    }
  }
  if (purged > 0) console.log(`[sweeper] purged ${purged} expired session(s) — ${sessions.size} active`);
}, SESSION_SWEEP_INTERVAL_MS).unref();

/* ============================================================================
 * 3b. SESSION TOKEN SIGNING  (fixes [4.3] context bleed / session forgery)
 * ============================================================================
 *  Clients receive and return a SIGNED token: "<rawId>.<hmac>".
 *  The rawId (Map key) is never trusted from the client — we verify the HMAC
 *  first. A client cannot forge, guess, or tamper with another user's id
 *  without the server secret, so cross-session access is impossible.
 * ========================================================================== */

/** Mint a brand-new unsigned session id. */
function mintRawId() {
  return 'sess_' + crypto.randomBytes(8).toString('hex');
}

/** Sign a rawId into a client-safe token: "<rawId>.<hmac>". */
function signSession(rawId) {
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(rawId)
    .digest('hex')
    .slice(0, SIG_LEN);
  return `${rawId}.${sig}`;
}

/**
 * Verify a client-supplied token. Returns the rawId if the signature is valid,
 * or null otherwise (constant-time compare, length-guarded).
 * @param {unknown} token
 * @returns {string|null}
 */
function verifySession(token) {
  if (typeof token !== 'string' || token.length > 200) return null;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null; // no separator, or empty id half
  const rawId = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(rawId)
    .digest('hex')
    .slice(0, SIG_LEN);
  if (sig.length !== expected.length) return null; // guard before timingSafeEqual
  try {
    if (crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return rawId;
  } catch {
    return null;
  }
  return null;
}

/* ============================================================================
 * 4. SHARED QUICK-REPLY OPTION SETS
 * ========================================================================== */
const OPTIONS = {
  main:            ['Track my order', 'Return policy', 'Recommend gear', 'Talk to a human'],
  postOrder:       ['Track my order', 'Recommend gear', 'Talk to a human'],
  afterDelivered:  ['Start a return', 'Recommend gear', 'Talk to a human'],
  recActivities:   ['Hiking', 'Camping', 'Backpacking'],
  recConditions:   ['Warm & sunny', 'Cold & snowy', 'Wet & rainy'],
  orderExamples:   ['111', '222', '333', 'Talk to a human'],
  // The escape button attached to every live-agent message.
  escapeQueue:     ['Start over'],
};

/**
 * The greeting shown after a reset (escape hatch + /api/reset both reuse it).
 */
const WELCOME_REPLY =
  "Welcome back to the trailhead! 🌲 I'm the North Star Support Bot — how can I help you today?";

/* ============================================================================
 * 5. CORE RESPONSE BUILDERS
 * ========================================================================== */

/**
 * [5.2] Priority order-number extractor.
 *  Old code used /#?\s*(\d+)/ which grabbed the FIRST digit run — so
 *  "I have 2 orders" falsely extracted "2". This extractor prefers explicit
 *  context, then hash-prefixed, then a standalone 3+ digit number, ignoring
 *  incidental small numbers entirely.
 * @returns {{num:string, invalid?:boolean}|null}
 */
function lookupOrder(text) {
  // 1) Explicit context: "order 111", "ord #222", "pedido 333"
  let m = text.match(/\b(?:order|ord|pedido)\s*#?\s*(\d+)/i);
  // 2) Hash-prefixed: "#111"
  if (!m) m = text.match(/#(\d+)/);
  // 3) Standalone 3+ digit number: "111" (skips "2", "24", etc.)
  if (!m) m = text.match(/\b(\d{3,})\b/);
  if (!m) return null;

  const num = m[1];
  return ORDERS[num] ? { num, ...ORDERS[num] } : { num, invalid: true };
}

/**
 * Build a product recommendation from two free-text answers (EN + ES keywords).
 */
function buildRecommendation(activity, condition) {
  const a = (activity || '').toLowerCase();
  const c = (condition || '').toLowerCase();
  let rec;

  if (/(camp|acamp)/.test(a)) {
    rec = 'our 4-season tents, cold-rated sleeping bags, and compact camp stoves';
  } else if (/(backpack|mochil)/.test(a)) {
    rec = 'an ultralight 65L pack, a titanium cookset, and a backpacking tent';
  } else if (/(hik|trek|trail|climb|caminat|senderis|excursi)/.test(a)) {
    if (/(cold|snow|winter|chill|freez|fr[ií]o|nieve|invierno)/.test(c)) {
      rec = 'a merino wool base layer, an insulated jacket, and waterproof hiking boots';
    } else if (/(rain|wet|water|storm|lluvia|mojad|tormenta|h[uú]med)/.test(c)) {
      rec = 'a Gore-Tex rain shell, quick-dry trail pants, and waterproof boots';
    } else {
      rec = 'a breathable hiking tee, trail shorts, and a lightweight daypack';
    }
  } else {
    rec = 'our best-selling all-weather starter kit';
  }

  return (
    `Based on that, I'd recommend ${rec}. 🏕️ You can browse the full range at ` +
    `https://northstaroutdoors.com/shop — want me to narrow it down further, ` +
    `or is there anything else I can help with?`
  );
}

/**
 * 2-strike escalation helper. Shared by IDLE fallback AND the sub-state handlers
 * so the safety net fires from EVERY state (fixes the [1.1] sub-state loop).
 * Returns a handoff response, or null if not yet escalating.
 */
function maybeEscalate(session) {
  if (session.fallbackCount >= 2) {
    session.state = STATES.HUMAN_HANDOFF;
    return {
      reply:
        "I want to make sure you're properly taken care of — I'm having a little trouble " +
        "keeping up, so let me hand you off to a human agent who can. 🧑‍🤝‍🧑 Connecting you now… " +
        "Tap **Start over** any time to come back to me.",
      options: OPTIONS.escapeQueue,
      sessionState: session.state,
    };
  }
  return null;
}

/**
 * Route a DETECTED intent (only called from the IDLE state). Any successful
 * intent clears the consecutive-fallback streak.
 */
function routeIntent(intent, session, text) {
  session.fallbackCount = 0;

  switch (intent) {
    case 'ORDER_TRACKING':
      session.state = STATES.AWAITING_ORDER_NUMBER;
      return {
        reply: "Absolutely — I can pull that right up. What's your order number? (Try 111, 222, or 333)",
        options: OPTIONS.orderExamples,
        sessionState: session.state,
      };

    case 'RETURN_EXCHANGE':
      return {
        reply:
          `Our return policy keeps it simple: you have ${RETURN_POLICY.window} to return ` +
          `items, as long as they're ${RETURN_POLICY.condition}.\n👉 Start here: ${RETURN_POLICY.link}`,
        options: OPTIONS.postOrder,
        sessionState: session.state,
      };

    case 'PRODUCT_RECOMMENDATION':
      session.state = STATES.AWAITING_REC_ACTIVITY;
      session.context = {};
      return {
        reply: "Love it — let's find your perfect kit. ⛰️ What kind of adventure are you planning?",
        options: OPTIONS.recActivities,
        sessionState: session.state,
      };

    case 'SHIPPING_INFO':
      return {
        reply:
          `Here's our shipping: \n🚚 Standard — ${SHIPPING_INFO.standard}\n⚡ Expedited — ${SHIPPING_INFO.expedited}\n` +
          `Want me to track an existing order?`,
        options: ['Track my order', 'Recommend gear', 'Talk to a human'],
        sessionState: session.state,
      };

    case 'HUMAN_HANDOFF':
      session.state = STATES.HUMAN_HANDOFF;
      return {
        reply:
          "No problem at all — I'm connecting you with a live member of our crew. 🧑‍🤝‍🧑 " +
          "An agent will jump in shortly. Changed your mind? Tap **Start over** to come back to me.",
        options: OPTIONS.escapeQueue,
        sessionState: session.state,
      };

    case 'GREETING':
      return {
        reply: "Hey there, adventurer! 🌲 Welcome to North Star Outdoors. How can I help you today?",
        options: OPTIONS.main,
        sessionState: session.state,
      };

    case 'THANKS':
      return {
        reply: "You're very welcome! 🏔️ Happy trails — anything else I can help with?",
        options: OPTIONS.main,
        sessionState: session.state,
      };

    default:
      return fallback(session, text);
  }
}

/**
 * GRACEFUL FALLBACK (IDLE state).
 *  - 1st unrecognised turn  → polite in-brand nudge + Quick Reply chips
 *  - 2nd CONSECUTIVE turn   → automatically escalate to HUMAN_HANDOFF
 */
function fallback(session, text) {
  session.fallbackCount += 1;
  const escalation = maybeEscalate(session);
  if (escalation) return escalation;

  return {
    reply:
      "Hmm, I'm not quite sure I caught that. 🌲 I can help with things like tracking an order, " +
      "our return policy, or finding the right gear. What would you like to do?",
    options: OPTIONS.main,
    sessionState: session.state,
  };
}

/* ----- State-specific handlers (called when mid-flow) --------------------- */

/**
 * AWAITING_ORDER_NUMBER — treat the message as an order number and look it up.
 *
 * [1.1] FIX: previously this reset fallbackCount = 0 unconditionally, so a user
 * stuck re-prompting for an order number could NEVER reach the 2-strike handoff.
 * Now: only a VALID lookup counts as "genuine progress" (resets the streak);
 * no-digits or an unknown number increments the streak and may escalate.
 */
function handleOrderNumber(session, text) {
  const result = lookupOrder(text);

  // No number, or a number that doesn't resolve → NOT genuine progress.
  if (!result || result.invalid) {
    session.fallbackCount += 1;
    const escalation = maybeEscalate(session);
    if (escalation) return escalation;

    return result && result.invalid
      ? {
          reply: `Hmm, I couldn't find order #${result.num} in our system. For this demo, try 111, 222, or 333.`,
          options: OPTIONS.orderExamples,
          sessionState: session.state,
        }
      : {
          reply: "I didn't catch an order number — it'll look like 111, 222, or 333. Which can I check?",
          options: OPTIONS.orderExamples,
          sessionState: session.state,
        };
  }

  // Valid order → genuine progress. Reset the streak and return to IDLE.
  session.fallbackCount = 0;
  session.state = STATES.IDLE;

  // Order #333 (Delivered) → ask a follow-up per the spec.
  if (result.num === '333') {
    return {
      reply: `Great news — Order #333 has been delivered! 🎉 Is everything good with your order, or would you like to start a return?`,
      options: OPTIONS.afterDelivered,
      sessionState: session.state,
    };
  }

  return {
    reply: `Here's the latest on Order #${result.num}: it's ${result.detail}. 📦 Anything else I can help with?`,
    options: OPTIONS.main,
    sessionState: session.state,
  };
}

/**
 * AWAITING_REC_ACTIVITY — store the activity, advance to the conditions question.
 *
 * Note: unlike the order flow, this 2-step flow is INHERENTLY self-terminating
 * (each step advances unconditionally), so it cannot loop — we reset the streak
 * because the user answered the question (genuine progress).
 */
function handleRecActivity(session, text) {
  session.fallbackCount = 0;
  session.context.activity = text;
  session.state = STATES.AWAITING_REC_CONDITION;
  return {
    reply: "Nice choice! ⛰️ And what kind of conditions will you be out in?",
    options: OPTIONS.recConditions,
    sessionState: session.state,
  };
}

/** AWAITING_REC_CONDITION — store condition, build the recommendation, → IDLE. */
function handleRecCondition(session, text) {
  session.fallbackCount = 0;
  session.context.condition = text;
  const recommendation = buildRecommendation(session.context.activity, session.context.condition);
  session.state = STATES.IDLE;
  session.context = {};
  return {
    reply: recommendation,
    options: OPTIONS.postOrder,
    sessionState: session.state,
  };
}

/* ============================================================================
 * 6. THE BRAIN — processMessage(rawId, text)
 * ============================================================================
 *  Dispatches a single user turn through the FSM.
 * ========================================================================== */
function processMessage(rawId, text) {
  const session = getSession(rawId);

  // ---------------------------------------------------------------------
  // [1.1] GLOBAL ESCAPE HATCH — checked FIRST, in EVERY state.
  // This guarantees no FSM node is ever an absorbing "black hole": a user
  // can always say "cancel" / "start over" / "salir" and return to IDLE,
  // whether they're awaiting an order number, mid-recommendation, or stuck
  // in the live-agent queue.
  // ---------------------------------------------------------------------
  if (ESCAPE_PHRASES.test(text)) {
    resetSession(session.id);
    return {
      reply: WELCOME_REPLY,
      options: OPTIONS.main,
      sessionState: session.state, // IDLE
    };
  }

  // HUMAN_HANDOFF: escape handled above; everything else re-acknowledges the
  // queue but ALWAYS shows the exit so the user is never trapped.
  if (session.state === STATES.HUMAN_HANDOFF) {
    return {
      reply:
        "You're still in the queue for a live agent. 🏕️ They'll be with you shortly — thanks for " +
        "hanging tight! Tap **Start over** any time to come back to me.",
      options: OPTIONS.escapeQueue,
      sessionState: session.state,
    };
  }

  switch (session.state) {
    case STATES.AWAITING_ORDER_NUMBER:
      // Mid-flow handoff still honoured (escape phrases handled globally above).
      if (detectIntent(text) === 'HUMAN_HANDOFF') return routeIntent('HUMAN_HANDOFF', session, text);
      return handleOrderNumber(session, text);

    case STATES.AWAITING_REC_ACTIVITY:
      if (detectIntent(text) === 'HUMAN_HANDOFF') return routeIntent('HUMAN_HANDOFF', session, text);
      return handleRecActivity(session, text);

    case STATES.AWAITING_REC_CONDITION:
      if (detectIntent(text) === 'HUMAN_HANDOFF') return routeIntent('HUMAN_HANDOFF', session, text);
      return handleRecCondition(session, text);

    case STATES.IDLE:
    default: {
      const intent = detectIntent(text);
      return intent ? routeIntent(intent, session, text) : fallback(session, text);
    }
  }
}

/* ============================================================================
 * 7. ROUTES
 * ========================================================================== */

// Health check.
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    brand: 'North Star Outdoors',
    activeSessions: sessions.size,
    uptime: process.uptime(),
  });
});

/**
 * POST /api/chat
 * body: { sessionId?, message }
 * →   { sessionId (signed token), reply, options, sessionState }
 *
 * [4.3] The client's sessionId is a SIGNED token; we verify it. If it's missing
 * or tampered, we mint a brand-new session — never trust a raw client id.
 * [3.1] Reject messages over MAX_MESSAGE_LENGTH (413).
 */
app.post('/api/chat', (req, res) => {
  const { sessionId: token, message } = req.body || {};

  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: 'A non-empty "message" is required.' });
  }

  const messageStr = String(message).trim();
  if (messageStr.length > MAX_MESSAGE_LENGTH) {
    return res.status(413).json({ error: `Message too long (max ${MAX_MESSAGE_LENGTH} characters).` });
  }

  // Verify the signed token → rawId, or start fresh. Never trust a forged id.
  const rawId = verifySession(token) || mintRawId();

  const result = processMessage(rawId, messageStr);

  // Always return a (re)signed token for the client to store and resend.
  res.json({ sessionId: signSession(rawId), ...result });
});

/**
 * POST /api/reset
 * body: { sessionId? }
 * →   { sessionId (signed token), reply, options, sessionState }
 *
 * Forces a session back to clean IDLE. Used by the UI's "New chat" button so
 * the backend's in-memory state resets in lockstep with the frontend. If the
 * token is missing/invalid we simply mint a fresh session.
 */
app.post('/api/reset', (req, res) => {
  const { sessionId: token } = req.body || {};
  const rawId = verifySession(token) || mintRawId();

  resetSession(rawId);

  res.json({
    sessionId: signSession(rawId),
    reply: WELCOME_REPLY,
    options: OPTIONS.main,
    sessionState: STATES.IDLE,
  });
});

/* ============================================================================
 * 8. BOOT
 * ========================================================================== */
app.listen(PORT, () => {
  console.log(`\n🏔️  North Star Support Bot backend running → http://localhost:${PORT}`);
  console.log(`   CORS origin: ${ALLOWED_ORIGIN}`);
  console.log(`   POST /api/chat   |   POST /api/reset   |   GET /api/health\n`);
});
