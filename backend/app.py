from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import asyncio
import threading
import uuid
import uvicorn
from dotenv import load_dotenv
import os
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import yfinance as yf
from newsapi import NewsApiClient

from src.multi_agent_stock_analyst.crew import MultiAgentStockAnalyst
from src.multi_agent_stock_analyst.models import (
    StockQuoteResponse,
    TickerAutocompleteResponse,
    TickerListResponse,
    UserPreferences,
)

from src.multi_agent_stock_analyst.utils import (
    normalize_live_update,
    enqueue_live_update,
    resolve_ticker_list,
    stock_quote_from_history,
    yahoo_autocomplete,
)

load_dotenv()

PREF_FILE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "knowledge", "user_preference.txt")


class AnalyzeStartRequest(BaseModel):
    ticker: str = "AAPL"
    query: str = ""


class AnalyzeFeedbackRequest(BaseModel):
    message: str = ""


class AnalyzeChatRequest(BaseModel):
    question: str
    context: Any = None


class AnalyzeSession:
    """Server-side buffer for one analyze/chat session (HTTP polling)."""

    __slots__ = ("lock", "seq", "events", "wait_event", "shared_state")

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.seq = 0
        self.events: list[dict] = []
        self.wait_event = threading.Event()
        self.shared_state: dict = {}


SESSIONS: dict[str, AnalyzeSession] = {}
SESSIONS_GUARD = threading.Lock()


def _emit_analyze_event(session_id: str, message: dict) -> None:
    with SESSIONS_GUARD:
        sess = SESSIONS.get(session_id)
    if sess is None:
        return
    with sess.lock:
        sess.seq += 1
        entry: dict = {"seq": sess.seq}
        entry.update(message)
        sess.events.append(entry)


def _poll_analyze_session(session_id: str, after: int) -> tuple[list[dict], int]:
    with SESSIONS_GUARD:
        sess = SESSIONS.get(session_id)
    if sess is None:
        raise HTTPException(status_code=404, detail="Unknown analyze session")
    with sess.lock:
        out = [{k: v for k, v in e.items() if k != "seq"} for e in sess.events if e["seq"] > after]
        high = max((e["seq"] for e in sess.events), default=0)
    return out, high


app = FastAPI(title="Agentic Stock Analyst")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health_check():
    """Simple ping to verify the API is running."""
    return {
        "status": "healthy",
        "service": "multi-agent-stock-analyst",
        "version": "1.0.0"
    }

@app.post("/api/analyze/start")
async def analyze_start(body: AnalyzeStartRequest):
    """Begin a crew run; client polls ``/api/analyze/session/{id}/poll`` for the same event shapes as before."""
    session_id = str(uuid.uuid4())
    sess = AnalyzeSession()
    with SESSIONS_GUARD:
        SESSIONS[session_id] = sess

    ticker = (body.ticker or "AAPL").strip() or "AAPL"
    user_query = body.query or ""

    def send_message_sync(message: dict):
        _emit_analyze_event(session_id, message)

    def run_crew(tk: str, uq: str):
        try:
            if uq:
                send_message_sync({"type": "status", "data": f"Processing query for {tk}: {uq}..."})
            else:
                send_message_sync({"type": "status", "data": f"Starting full analysis for {tk}..."})

            stock_crew = MultiAgentStockAnalyst()
            with SESSIONS_GUARD:
                s = SESSIONS.get(session_id)
            if s is None:
                return
            stock_crew.setup_websocket(
                send_message_sync=send_message_sync,
                wait_event=s.wait_event,
                shared_state=s.shared_state,
            )
            inputs = {"ticker": tk, "user_query": uq}
            result = stock_crew.kickoff_analysis(inputs)
            final_data = result.pydantic.model_dump() if result.pydantic else result.raw
            send_message_sync({"type": "complete", "data": final_data})
        except Exception as e:
            send_message_sync({"type": "error", "data": str(e)})

    threading.Thread(target=run_crew, args=(ticker, user_query), daemon=True).start()
    return {"session_id": session_id}


@app.get("/api/analyze/session/{session_id}/poll")
async def analyze_poll(session_id: str, after: int = 0):
    """Return new events since ``after`` (monotonic seq). Same JSON objects as the old WebSocket frames."""
    events, next_after = _poll_analyze_session(session_id, after)
    return {"events": events, "next_after": next_after}


@app.post("/api/analyze/session/{session_id}/feedback")
async def analyze_feedback(session_id: str, body: AnalyzeFeedbackRequest):
    with SESSIONS_GUARD:
        sess = SESSIONS.get(session_id)
    if sess is None:
        raise HTTPException(status_code=404, detail="Unknown analyze session")
    sess.shared_state["feedback"] = body.message
    sess.wait_event.set()
    return {"ok": True}


@app.post("/api/analyze/session/{session_id}/chat")
async def analyze_chat(session_id: str, body: AnalyzeChatRequest):
    with SESSIONS_GUARD:
        if session_id not in SESSIONS:
            raise HTTPException(status_code=404, detail="Unknown analyze session")

    def send_message_sync(message: dict):
        _emit_analyze_event(session_id, message)

    def run_chat():
        try:
            send_message_sync({"type": "status", "data": "Consulting advisor..."})
            stock_crew = MultiAgentStockAnalyst()
            raw_ctx = body.context
            ctx: dict = raw_ctx if isinstance(raw_ctx, dict) else {}
            answer = stock_crew.answer_follow_up(body.question, ctx)
            send_message_sync({"type": "chat_response", "data": answer})
        except Exception as e:
            send_message_sync({"type": "error", "data": str(e)})

    threading.Thread(target=run_chat, daemon=True).start()
    return {"ok": True}


@app.get("/api/preferences")
async def get_preferences():
    """Fetches the current user preferences to populate the frontend form."""
    if not os.path.exists(PREF_FILE_PATH):
        return {"content": "No preferences set."}
    
    with open(PREF_FILE_PATH, "r") as file:
        content = file.read()
    return {"content": content}

@app.post("/api/preferences")
async def update_preferences(prefs: UserPreferences):
    """Overwrites the RAG knowledge document with new frontend settings."""
    try:
        formatted_content = (
            f"User Investment Profile:\n"
            f"- Risk Tolerance: {prefs.risk_tolerance}\n"
            f"- Horizon: {prefs.investment_horizon}\n"
            f"- Preferences: {prefs.preferences}\n"
        )
        
        # Ensure directory exists
        os.makedirs(os.path.dirname(PREF_FILE_PATH), exist_ok=True)
        
        with open(PREF_FILE_PATH, "w") as file:
            file.write(formatted_content)
            
        return {"status": "success", "message": "Preferences updated for RAG."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    



@app.websocket("/api/stock/live/{ticker}")
async def stream_live_quote(websocket: WebSocket, ticker: str):
    """Proxy yfinance websocket ticks for one ticker to the frontend."""
    symbol = ticker.strip().upper()
    if not symbol:
        await websocket.close(code=1008)
        return

    await websocket.accept()

    stream = yf.AsyncWebSocket(verbose=False)
    queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=100)

    async def on_tick(message: dict):
        update = normalize_live_update(message, symbol)
        if update is not None:
            enqueue_live_update(queue, update)

    listen_task = asyncio.create_task(stream.listen(on_tick))

    try:
        await stream.subscribe(symbol)
        await websocket.send_json({"type": "subscribed", "ticker": symbol})

        while True:
            payload = await queue.get()
            await websocket.send_json(payload)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_json({"type": "error", "detail": str(e)})
        except Exception:
            pass
    finally:
        listen_task.cancel()
        try:
            await stream.unsubscribe(symbol)
        except Exception:
            pass
        try:
            await stream.close()
        except Exception:
            pass



@app.get("/api/tickers", response_model=TickerListResponse)
async def list_popular_tickers(limit: int = 50):
    """Ticker list from yfinance Yahoo screener (``most_actives``), with JSON/minimal fallback."""
    if limit < 1:
        limit = 1
    if limit > 250:
        limit = 250
    try:
        tickers, source = await asyncio.to_thread(resolve_ticker_list, limit)
        return TickerListResponse(tickers=tickers, count=len(tickers), source=source)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


async def _autocomplete_handler(q: str, limit: int) -> TickerAutocompleteResponse:
    if limit < 1:
        limit = 1
    if limit > 25:
        limit = 25
    try:
        return await asyncio.to_thread(yahoo_autocomplete, q, limit)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/stock/autocomplete", response_model=TickerAutocompleteResponse)
async def autocomplete_tickers(q: str = "", limit: int = 12):
    """Suggest tickers by **company name** or symbol (phrase + fuzzy match via Yahoo)."""
    return await _autocomplete_handler(q, limit)


@app.get("/api/stock/search", response_model=TickerAutocompleteResponse)
async def search_stocks(q: str = "", limit: int = 12):
    """Alias of ``/api/stock/autocomplete``: find symbols by name or ticker."""
    return await _autocomplete_handler(q, limit)


@app.get("/api/stock/{ticker}/quote", response_model=StockQuoteResponse)
async def get_fast_quote(ticker: str):
    """Price, multi-horizon % moves, volume vs 20d avg, simple MAs, and a compact behavior summary."""
    try:
        stock = yf.Ticker(ticker.upper())
        hist = stock.history(period="3mo", interval="1d")
        return stock_quote_from_history(ticker, hist)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    



newsapi = NewsApiClient(api_key=os.getenv("NEWSAPI_KEY"))

@app.get("/api/stock/{ticker}/news")
async def get_fast_news(ticker: str):
    """Returns raw news headlines from NewsAPI to display in a frontend sidebar."""
    try:
        # Fetch the top 5 most relevant recent articles for the ticker
        all_articles = newsapi.get_everything(
            q=ticker.upper(),
            language='en',
            sort_by='relevancy',
            page_size=5 
        )
        
        if all_articles['status'] == 'ok':
            # Clean up the response so the frontend gets exactly what it needs
            clean_news = [
                {
                    "title": article['title'],
                    "source": article['source']['name'],
                    "url": article['url'],
                    "publishedAt": article['publishedAt']
                }
                for article in all_articles['articles']
            ]
            return {"ticker": ticker.upper(), "news": clean_news}
        else:
            return {"ticker": ticker.upper(), "news": []}
            
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    

if __name__ == "__main__":
    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)