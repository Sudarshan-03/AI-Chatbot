import { useState, useEffect, useRef } from 'react';

/* ===========================================================================
 *  North Star Support Bot — React (Vite) + Tailwind frontend
 * ---------------------------------------------------------------------------
 *  Presentation layer. All chat logic + the backend API contract
 *  (POST /api/chat, POST /api/reset, sessionId handling, Quick Reply dispatch)
 *  are preserved from the original; this pass refines the visuals only:
 *    • gradient header with a mountain-silhouette overlay + brand logo mark
 *    • textured message viewport, timestamps, refined bubbles & avatars
 *    • iconographic Quick Reply chips with hover-lift
 *    • "Bot is typing…" indicator with avatar + bouncing dots
 *    • paper-plane composer with a gradient send button
 * ==========================================================================*/

const API_BASE = 'http://localhost:3001/api';

/* ---------------------------------------------------------------------------
 *  Inline icon set (stroke-based, Lucide-style). Defined inline so we add
 *  ZERO new dependencies — keeps the bundle lean for the demo handoff.
 * ------------------------------------------------------------------------- */
const ICON_PATHS = {
  mountain: <path d="m8 3 4 8 5-5 5 15H2L8 3z" />,
  send: (
    <>
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </>
  ),
  refresh: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
  package: (
    <>
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="M3.3 7 12 12l8.7-5" />
      <path d="M12 22V12" />
    </>
  ),
  return: (
    <>
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
    </>
  ),
  sparkles: (
    <>
      <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z" />
      <path d="M5 3v4" />
      <path d="M19 17v4" />
      <path d="M3 5h4" />
      <path d="M17 19h4" />
    </>
  ),
  headset: (
    <>
      <path d="M3 14v-3a9 9 0 0 1 18 0v3" />
      <path d="M21 16a2 2 0 0 1-2 2h-1v-5h1a2 2 0 0 1 2 2z" />
      <path d="M3 16a2 2 0 0 0 2 2h1v-5H5a2 2 0 0 0-2 2z" />
      <path d="M21 16v1a4 4 0 0 1-4 4h-5" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
};

function Icon({ name, className = 'w-5 h-5' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

/** Pick a relevant icon for a Quick Reply chip based on its wording. */
function iconForOption(label) {
  const t = label.toLowerCase();
  if (/track|order|111|222|333/.test(t)) return 'package';
  if (/return|refund|exchange/.test(t)) return 'return';
  if (/recommend|gear|hiking|camping|backpacking|warm|cold|wet/.test(t)) return 'sparkles';
  if (/human|agent|start over|start a return/.test(t)) return 'headset';
  return null;
}

/** Format a ms timestamp as a short "2:34 PM" string. */
function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/* The welcome bubble shown on first load (timestamp assigned at mount). */
const WELCOME = {
  id: 'welcome',
  sender: 'bot',
  text:
    "Hey there, adventurer! 🌲 I'm the North Star Support Bot. How can I help you hit the trail today?",
  options: ['Track my order', 'Return policy', 'Recommend gear', 'Talk to a human'],
};

export default function App() {
  const [messages, setMessages] = useState(() => [{ ...WELCOME, time: Date.now() }]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [sessionId, setSessionId] = useState(
    () => localStorage.getItem('nso_session') || ''
  );

  const viewportRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-scroll to the newest message / typing indicator.
  useEffect(() => {
    const el = viewportRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, isTyping]);

  /* -----------------------------------------------------------------------
   *  Send a message (typed text OR a Quick Reply chip value).
   * --------------------------------------------------------------------- */
  const sendMessage = async (text) => {
    const trimmed = String(text).trim();
    if (!trimmed || isTyping) return;

    const userMsg = { id: Date.now(), sender: 'user', text: trimmed, time: Date.now() };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsTyping(true);

    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: trimmed }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (data.sessionId) {
        setSessionId(data.sessionId);
        localStorage.setItem('nso_session', data.sessionId);
      }

      // Realistic typing delay, scaled to reply length.
      const delay = Math.min(1400, 550 + data.reply.length * 9);
      setTimeout(() => {
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now() + 1,
            sender: 'bot',
            text: data.reply,
            options: Array.isArray(data.options) ? data.options : [],
            state: data.sessionState,
            time: Date.now(),
          },
        ]);
        setIsTyping(false);
        inputRef.current?.focus();
      }, delay);
    } catch (err) {
      setIsTyping(false);
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          sender: 'bot',
          text:
            '📡 Oops — I lost signal on the trail. Make sure the backend is running (npm start in /backend), then try again.',
          options: [],
          time: Date.now(),
        },
      ]);
    }
  };

  /* -----------------------------------------------------------------------
   *  resetChat — clears local state AND tells the backend to reset the
   *  session to IDLE (so we can never get trapped in HUMAN_HANDOFF).
   * --------------------------------------------------------------------- */
  const resetChat = async () => {
    setIsTyping(false);

    if (sessionId) {
      try {
        await fetch(`${API_BASE}/reset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        });
      } catch {
        /* network error — local reset still gives a clean slate */
      }
    }

    localStorage.removeItem('nso_session');
    setSessionId('');
    setMessages([{ ...WELCOME, time: Date.now() }]);
    setInput('');
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    sendMessage(input);
  };

  return (
    <div className="app-shell">
      <div className="chat-card">
        {/* ---- Header ------------------------------------------------- */}
        <header className="chat-header">
          {/* Mountain silhouette overlay (decorative) */}
          <svg
            className="header-ridge"
            viewBox="0 0 600 120"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path
              d="M0 120 L0 80 L70 40 L130 75 L200 25 L270 70 L340 35 L420 80 L490 30 L560 70 L600 50 L600 120 Z"
              fill="rgba(255,255,255,0.06)"
            />
            <path
              d="M0 120 L0 100 L80 70 L150 95 L230 55 L310 90 L390 60 L470 95 L540 65 L600 90 L600 120 Z"
              fill="rgba(255,255,255,0.05)"
            />
          </svg>

          <div className="header-inner">
            <div className="logo-mark">
              <Icon name="mountain" className="w-6 h-6" />
            </div>
            <div className="header-titles">
              <h1>North Star Support Bot</h1>
              <p>
                <span className="online-dot" />
                Online · typically replies instantly
              </p>
            </div>
            <button onClick={resetChat} className="ghost-btn" title="Start a new chat">
              <Icon name="refresh" className="w-4 h-4" />
              <span>New chat</span>
            </button>
          </div>
        </header>

        {/* ---- Messages viewport ------------------------------------- */}
        <div ref={viewportRef} className="chat-viewport">
          {messages.map((msg, i) =>
            msg.sender === 'bot' ? (
              <BotBubble
                key={msg.id}
                msg={msg}
                onQuickReply={sendMessage}
                disabled={isTyping}
                showAvatar={i === 0 || messages[i - 1].sender !== 'bot'}
              />
            ) : (
              <UserBubble key={msg.id} text={msg.text} time={msg.time} />
            )
          )}

          {isTyping && <TypingIndicator />}
        </div>

        {/* ---- Composer --------------------------------------------- */}
        <form onSubmit={handleSubmit} className="composer">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type your message…"
            aria-label="Message"
          />
          <button
            type="submit"
            disabled={!input.trim() || isTyping}
            className="send-btn"
            title="Send"
          >
            <Icon name="send" className="w-5 h-5" />
          </button>
        </form>
      </div>
    </div>
  );
}

/* ===========================================================================
 *  Presentational components
 * ==========================================================================*/

function BotAvatar({ size = 'md' }) {
  const dim = size === 'sm' ? 'w-7 h-7' : 'w-9 h-9';
  const ic = size === 'sm' ? 'w-4 h-4' : 'w-5 h-5';
  return (
    <div className={`bot-avatar ${dim}`}>
      <Icon name="mountain" className={ic} />
    </div>
  );
}

function BotBubble({ msg, onQuickReply, disabled, showAvatar }) {
  return (
    <div className="bot-row msg-enter">
      <div className="bot-row__avatar">{showAvatar ? <BotAvatar /> : <span className="avatar-spacer" />}</div>
      <div className="bot-row__body">
        {showAvatar && (
          <div className="bubble-meta">
            <span className="bubble-name">North Star Bot</span>
            <span className="bubble-time">{formatTime(msg.time)}</span>
          </div>
        )}
        <div className="bot-bubble">{msg.text}</div>

        {msg.options && msg.options.length > 0 && (
          <div className="quick-replies">
            {msg.options.map((opt) => {
              const icon = iconForOption(opt);
              return (
                <button
                  key={opt}
                  onClick={() => onQuickReply(opt)}
                  disabled={disabled}
                  className="quick-reply"
                >
                  {icon && <Icon name={icon} className="w-3.5 h-3.5" />}
                  <span>{opt}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function UserBubble({ text, time }) {
  return (
    <div className="user-row msg-enter">
      <div className="user-bubble">
        <span>{text}</span>
        <span className="user-time">{formatTime(time)}</span>
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="bot-row msg-enter">
      <div className="bot-row__avatar">
        <BotAvatar />
      </div>
      <div className="bot-row__body">
        <div className="bot-bubble typing-bubble">
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="typing-dot" />
        </div>
      </div>
    </div>
  );
}
