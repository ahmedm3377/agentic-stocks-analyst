# HTTP polling API: Agentic Stock Analyst

The multi-agent analyze flow uses **HTTP** (no WebSocket): you **start** a session, **poll** for events (same JSON shapes as before), then **POST** feedback or chat on the same `session_id`.

Base URL examples: `http://127.0.0.1:8000` (local), or your deployed API origin.

---

## 1. Start an analysis

**`POST /api/analyze/start`**

Body:

```json
{
  "ticker": "TSLA",
  "query": "What are the latest news catalysts for this stock?"
}
```

Response:

```json
{ "session_id": "8f3c2e1a-..." }
```

---

## 2. Poll for events

**`GET /api/analyze/session/{session_id}/poll?after=0`**

- `after` is the last `next_after` value you received (start with `0`).
- Response:

```json
{
  "events": [
    { "type": "status", "data": "Processing query for TSLA: ..." },
    { "type": "task_started", "data": { "task_name": "...", "agent_role": "..." } },
    { "type": "task_output", "data": { "task_name": "...", "agent_role": "...", "output": "..." } }
  ],
  "next_after": 12
}
```

Poll periodically (e.g. every 500–1000 ms) until you see `complete`, `error`, or you stop.

---

## 3. Human review (draft ready)

When polling returns:

```json
{
  "type": "review_needed",
  "data": "MARKET VIEW:\n..."
}
```

**`POST /api/analyze/session/{session_id}/feedback`**

```json
{
  "message": "Rewrite the report to be more concise..."
}
```

Continue polling; the crew resumes and later emits `complete` or `error`.

---

## 4. Final report

Event shape (unchanged):

```json
{
  "type": "complete",
  "data": {
    "ticker": "TSLA",
    "market_view": "...",
    "trend": "...",
    "key_catalysts": ["..."],
    "bull_case": "...",
    "bear_case": "...",
    "main_risks": ["..."],
    "confidence_level": "..."
  }
}
```

---

## 5. Follow-up chat (same session)

**`POST /api/analyze/session/{session_id}/chat`**

```json
{
  "question": "What exactly do they mean by …?",
  "context": {
    "ticker": "TSLA",
    "market_view": "...",
    "bear_case": "..."
  }
}
```

Keep polling; you will receive:

```json
{ "type": "chat_response", "data": "..." }
```

Errors are emitted as `{ "type": "error", "data": "..." }` like before.

---

## Other endpoints

- **`GET /api/health`** — liveness.
- **`GET` / `POST /api/preferences`** — investment profile text for RAG.
- **`GET /api/stock/...`** — quotes, news, etc.
- **`WebSocket /api/stock/live/{ticker}`** — optional live quote stream (unchanged).

---

## Production note

You **do not** need WebSocket proxy rules on Nginx for `/api/analyze` anymore; standard HTTP `proxy_pass` for `/api/` is enough. If you still use the live quote WebSocket, keep `Upgrade` headers only for that path if you split routes.
