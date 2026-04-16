# Agentic Stock Analyst API Reference (Frontend)

Base URL (local):
- http://127.0.0.1:8000

## Overview

This document describes all backend endpoints exposed by the FastAPI app for frontend integration.

## 1) Health Check

- Method: GET
- Path: /api/health
- Purpose: Verify backend service availability.

### Success Response (200)

```json
{
  "status": "healthy",
  "service": "multi-agent-stock-analyst",
  "version": "1.0.0"
}
```

## 2) Analyze Stock (WebSocket)

- Protocol: WebSocket
- Path: /api/analyze
- Purpose: Run a multi-agent analysis workflow and stream progress updates.

### Connection

Connect to:
- ws://127.0.0.1:8000/api/analyze

### Client -> Server Messages

#### Start analysis

```json
{
  "action": "start",
  "ticker": "AAPL"
}
```

Notes:
- ticker is optional in the current backend and defaults to AAPL if omitted.

#### Submit human feedback (during workflow)

```json
{
  "action": "feedback",
  "message": "Please provide a more conservative recommendation."
}
```

### Server -> Client Messages

#### Status update

```json
{
  "type": "status",
  "data": "Starting analysis for AAPL..."
}
```

#### Final result

```json
{
  "type": "complete",
  "data": {
    "ticker": "AAPL",
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

Notes:
- data is typically the structured final report object above.
- If structured output is unavailable, the backend may return a plain string in data.

#### Error

```json
{
  "type": "error",
  "data": "Error details"
}
```

### Frontend Handling Recommendation

- Keep the socket open for the full analysis lifecycle.
- Render all status messages as a timeline/log.
- On complete, detect whether data is an object or string and render accordingly.
- On error, stop loading state and show retry action.

## 3) Get User Preferences

- Method: GET
- Path: /api/preferences
- Purpose: Fetch stored preference text used by backend knowledge/RAG.

### Success Response (200)

When file exists:

```json
{
  "content": "User Investment Profile:\n- Risk Tolerance: ...\n- Horizon: ...\n- Preferences: ...\n"
}
```

When no file exists:

```json
{
  "content": "No preferences set."
}
```

## 4) Update User Preferences

- Method: POST
- Path: /api/preferences
- Purpose: Save frontend preference form values to backend knowledge file.

### Request Body

```json
{
  "risk_tolerance": "medium",
  "investment_horizon": "long-term",
  "preferences": "Technology and dividend stocks"
}
```

Required fields:
- risk_tolerance: string
- investment_horizon: string
- preferences: string

### Success Response (200)

```json
{
  "status": "success",
  "message": "Preferences updated for RAG."
}
```

### Error Response (500)

```json
{
  "detail": "Error details"
}
```

## 5) Get Fast Stock Quote

- Method: GET
- Path: /api/stock/{ticker}/quote
- Purpose: Return immediate quote info for chart/bootstrap display.

Example:
- /api/stock/AAPL/quote

### Success Response (200)

```json
{
  "ticker": "AAPL",
  "price": 214.12,
  "currency": "USD"
}
```

### Error Responses

- 404: ticker not found
- 500: backend/provider error

## 6) Get Stock News

- Method: GET
- Path: /api/stock/{ticker}/news
- Purpose: Return latest relevant headlines from NewsAPI.

Example:
- /api/stock/AAPL/news

### Success Response (200)

```json
{
  "ticker": "AAPL",
  "news": [
    {
      "title": "Apple unveils new product roadmap",
      "source": "Reuters",
      "url": "https://example.com/article",
      "publishedAt": "2026-04-15T10:20:30Z"
    }
  ]
}
```

Notes:
- Backend requests up to 5 articles.
- If provider returns no results, news is an empty array.

### Error Response (500)

```json
{
  "detail": "Error details"
}
```

## Suggested Frontend Integration Order

1. Call GET /api/stock/{ticker}/quote for immediate UI update.
2. Call GET /api/stock/{ticker}/news for sidebar headlines.
3. Open WebSocket /api/analyze and send action=start for deep analysis.
4. Listen for status/complete/error events and update UI in real time.
5. Use GET/POST /api/preferences from settings/profile screen.
