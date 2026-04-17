from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from src.multi_agent_stock_analyst.crew import MultiAgentStockAnalyst
from src.multi_agent_stock_analyst.models import (
    BasicIndicators,
    MarketBehaviorSummary,
    StockQuoteChanges,
    StockQuoteResponse,
    TickerAutocompleteResponse,
    TickerEntry,
    TickerListResponse,
    TickerSuggestion,
    UserPreferences,
)
import asyncio
import json
import threading
import time
import uvicorn
from dotenv import load_dotenv
import os
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import yfinance as yf
from newsapi import NewsApiClient

load_dotenv()



PREF_FILE_PATH = "knowledge/user_preference.txt"
POPULAR_TICKERS_PATH = os.path.join(os.path.dirname(__file__), "knowledge", "popular_tickers.json")

VOLUME_UNUSUAL_RATIO = 1.5

_YAHOO_SEARCH_URL = "https://query2.finance.yahoo.com/v1/finance/search"
_ALLOWED_QUOTE_TYPES = frozenset({"EQUITY", "ETF", "MUTUALFUND"})
_AUTOCOMPLETE_CACHE: dict[str, tuple[float, TickerAutocompleteResponse]] = {}
_AUTOCOMPLETE_TTL_SEC = 90.0

_TICKER_LIST_CACHE: dict[int, tuple[float, list[TickerEntry]]] = {}
_TICKER_LIST_TTL_SEC = 600.0
_YF_TICKER_SCREENER = "most_actives"


def _fetch_tickers_yfinance(count: int) -> list[TickerEntry]:
    """Pull liquid US symbols via yfinance predefined screener (Yahoo Finance)."""
    cnt = max(1, min(int(count), 250))
    result = yf.screen(_YF_TICKER_SCREENER, count=cnt)
    quotes = result.get("quotes") or []
    out: list[TickerEntry] = []
    for item in quotes:
        sym = item.get("symbol")
        if not sym:
            continue
        qt = item.get("quoteType") or ""
        if qt not in ("EQUITY", "ETF"):
            continue
        name = item.get("longName") or item.get("shortName") or item.get("displayName") or sym
        out.append(TickerEntry(symbol=str(sym).strip(), name=str(name).strip()))
    return out


def _load_tickers_from_json(path: str, limit: int) -> list[TickerEntry]:
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    rows = [
        TickerEntry(symbol=str(x["symbol"]).strip(), name=str(x["name"]).strip()) for x in raw
    ]
    return rows[: max(1, min(limit, len(rows)))]


def _resolve_ticker_list(limit: int) -> tuple[list[TickerEntry], str]:
    """yfinance screener first, then JSON file, then minimal defaults."""
    lim = max(1, min(int(limit), 250))
    now = time.monotonic()
    cached = _TICKER_LIST_CACHE.get(lim)
    if cached is not None:
        cached_at, rows = cached
        if now - cached_at < _TICKER_LIST_TTL_SEC and rows:
            return rows, f"yfinance:{_YF_TICKER_SCREENER} (cached)"

    try:
        rows = _fetch_tickers_yfinance(lim)
        if rows:
            _TICKER_LIST_CACHE[lim] = (now, rows)
            return rows, f"yfinance:{_YF_TICKER_SCREENER}"
    except Exception:
        pass

    try:
        rows = _load_tickers_from_json(POPULAR_TICKERS_PATH, lim)
        if rows:
            return rows, "curated:knowledge/popular_tickers.json"
    except (OSError, KeyError, TypeError, json.JSONDecodeError, ValueError):
        pass

    fallback = [
        TickerEntry(symbol="AAPL", name="Apple Inc."),
        TickerEntry(symbol="MSFT", name="Microsoft Corporation"),
    ]
    return fallback[:lim], "fallback:minimal"


def _quote_dicts_to_suggestions(quotes: list, lim: int) -> list[TickerSuggestion]:
    """Normalize Yahoo / yfinance quote dicts into ticker rows (symbol + company name)."""
    out: list[TickerSuggestion] = []
    for item in quotes:
        if len(out) >= lim:
            break
        if not isinstance(item, dict):
            continue
        sym = item.get("symbol")
        if not sym or not isinstance(sym, str):
            continue
        qt = item.get("quoteType") or item.get("quotetype") or ""
        if qt and qt not in _ALLOWED_QUOTE_TYPES:
            continue
        raw_name = (
            item.get("longName")
            or item.get("longname")
            or item.get("shortName")
            or item.get("shortname")
            or item.get("displayName")
            or sym
        )
        name = raw_name if isinstance(raw_name, str) else sym
        ex = item.get("exchange")
        exchange = ex if isinstance(ex, str) else None
        kind = str(qt) if qt else None
        out.append(
            TickerSuggestion(symbol=sym.strip(), name=name.strip(), exchange=exchange, kind=kind)
        )
    return out


def _yahoo_autocomplete_fetch_quotes(q: str, lim: int) -> list:
    """Try yfinance Search (phrase + fuzzy; best for company names), then Yahoo HTTP fallback."""
    try:
        search = yf.Search(
            q,
            max_results=lim,
            news_count=0,
            lists_count=0,
            enable_fuzzy_query=True,
            timeout=15,
        )
        if search.quotes:
            return search.quotes
    except Exception:
        pass

    params = {
        "q": q,
        "quotesCount": lim,
        "newsCount": 0,
        "listsCount": 0,
        "quotesQueryId": "tss_match_phrase_query",
        "enableFuzzyQuery": "true",
    }
    url = f"{_YAHOO_SEARCH_URL}?{urlencode(params)}"
    req = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json",
        },
    )
    with urlopen(req, timeout=12) as resp:
        payload = json.loads(resp.read().decode())
    return payload.get("quotes") or []


def _yahoo_autocomplete(query: str, limit: int) -> TickerAutocompleteResponse:
    """Match tickers by symbol or company name (Yahoo search)."""
    q = query.strip()
    if not q:
        return TickerAutocompleteResponse(suggestions=[])

    lim = max(1, min(int(limit), 25))
    cache_key = f"{q.lower()}:{lim}"
    now = time.monotonic()
    cached = _AUTOCOMPLETE_CACHE.get(cache_key)
    if cached is not None:
        cached_at, val = cached
        if now - cached_at < _AUTOCOMPLETE_TTL_SEC:
            return val

    try:
        quotes = _yahoo_autocomplete_fetch_quotes(q, lim)
    except HTTPError as e:
        if e.code == 429:
            empty = TickerAutocompleteResponse(suggestions=[])
            _AUTOCOMPLETE_CACHE[cache_key] = (now, empty)
            return empty
        raise HTTPException(status_code=502, detail=f"Autocomplete unavailable: {e}") from e
    except (URLError, TimeoutError, json.JSONDecodeError, ValueError) as e:
        raise HTTPException(status_code=502, detail=f"Autocomplete unavailable: {e}") from e

    out = _quote_dicts_to_suggestions(quotes, lim)
    result = TickerAutocompleteResponse(suggestions=out)
    _AUTOCOMPLETE_CACHE[cache_key] = (now, result)
    return result


def _normalize_live_update(message: dict, subscribed_symbol: str) -> dict | None:
    """Map a yfinance stream tick into a frontend-friendly payload."""
    symbol = str(message.get("id") or "").upper()
    if symbol != subscribed_symbol:
        return None

    price = message.get("price")
    if price is None:
        return None

    return {
        "type": "quote_update",
        "ticker": symbol,
        "price": float(price),
        "change_pct": message.get("changePercent"),
        "day_volume": message.get("dayVolume"),
        "market_state": message.get("marketHours"),
        "ts": message.get("time"),
    }


def _enqueue_live_update(queue: asyncio.Queue[dict], update: dict):
    """Keep only the freshest stream updates if queue gets full."""
    try:
        queue.put_nowait(update)
    except asyncio.QueueFull:
        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
        try:
            queue.put_nowait(update)
        except asyncio.QueueFull:
            pass


def _stock_quote_from_history(ticker: str, hist) -> StockQuoteResponse:
    """Derive price, multi-horizon returns, volume context, and a compact behavior summary from daily bars."""
    h = hist.dropna(how="any")
    if h.empty:
        raise HTTPException(status_code=404, detail="Ticker not found")

    close = h["Close"]
    vol = h["Volume"]
    last_px = float(close.iloc[-1])

    day_pct = float((close.iloc[-1] / close.iloc[-2] - 1) * 100) if len(close) >= 2 else None
    week_pct = float((close.iloc[-1] / close.iloc[-6] - 1) * 100) if len(close) >= 6 else None
    month_pct = float((close.iloc[-1] / close.iloc[-22] - 1) * 100) if len(close) >= 22 else None

    sma_5 = float(close.iloc[-5:].mean()) if len(close) >= 5 else None
    sma_20 = float(close.iloc[-20:].mean()) if len(close) >= 20 else None

    vol_ratio: float | None = None
    if len(vol) >= 21:
        last_v = float(vol.iloc[-1])
        prior_avg = float(vol.iloc[-21:-1].mean())
        vol_ratio = (last_v / prior_avg) if prior_avg > 0 else None

    unusual = bool(vol_ratio is not None and vol_ratio >= VOLUME_UNUSUAL_RATIO)

    # Trend: blend horizon returns with position vs SMA20 when available
    above_sma20 = sma_20 is not None and last_px >= sma_20
    below_sma20 = sma_20 is not None and last_px < sma_20
    up_horizons = sum(
        1
        for x in (day_pct, week_pct, month_pct)
        if x is not None and x > 0
    )
    down_horizons = sum(
        1
        for x in (day_pct, week_pct, month_pct)
        if x is not None and x < 0
    )
    if (month_pct is not None and month_pct > 1.0 and above_sma20) or (
        up_horizons >= 2 and (week_pct or 0) > 0 and above_sma20
    ):
        trend: str = "bullish"
    elif (month_pct is not None and month_pct < -1.0 and below_sma20) or (
        down_horizons >= 2 and (week_pct or 0) < 0 and below_sma20
    ):
        trend = "bearish"
    elif sma_20 is None and up_horizons >= 2:
        trend = "bullish"
    elif sma_20 is None and down_horizons >= 2:
        trend = "bearish"
    else:
        trend = "mixed"

    # Momentum: recent pace + short vs longer average
    if week_pct is not None and week_pct > 2.5:
        momentum = "strong"
    elif week_pct is not None and week_pct < -2.5:
        momentum = "weak"
    elif sma_5 is not None and sma_20 is not None:
        if sma_5 > sma_20 * 1.02:
            momentum = "strong"
        elif sma_5 < sma_20 * 0.98:
            momentum = "weak"
        else:
            momentum = "moderate"
    elif day_pct is not None and day_pct > 1.0:
        momentum = "strong"
    elif day_pct is not None and day_pct < -1.0:
        momentum = "weak"
    else:
        momentum = "moderate"

    return StockQuoteResponse(
        ticker=ticker.upper(),
        price=last_px,
        currency="USD",
        changes_pct=StockQuoteChanges(day=day_pct, week=week_pct, month=month_pct),
        volume_vs_20d_avg=vol_ratio,
        indicators=BasicIndicators(sma_5=sma_5, sma_20=sma_20),
        summary=MarketBehaviorSummary(
            trend=trend,
            momentum=momentum,
            unusual_activity=unusual,
        ),
    )


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


@app.websocket("/api/analyze")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    
    # These variables manage the cross-thread communication
    wait_event = threading.Event()
    shared_state = {}

    # ---> THE FIX: Capture the main thread's event loop HERE <---
    main_loop = asyncio.get_running_loop()

    # Helper function to let the synchronous Crew thread send async WebSocket messages
    def send_message_sync(message: dict):
        try:
            # Only try to send the message if the main event loop is still alive
            if not main_loop.is_closed():
                asyncio.run_coroutine_threadsafe(websocket.send_json(message), main_loop)
        except Exception as e:
            print(f"Failed to send WebSocket message (client likely disconnected): {e}")

    # Function to run the Crew (this will run in a separate thread)
  # Function to run the Crew (this will run in a separate thread)
    def run_crew(ticker: str):
        try:
            send_message_sync({"type": "status", "data": f"Starting analysis for {ticker}..."})
            
            # 1. Instantiate the crew completely empty to avoid decorator bugs
            stock_crew = MultiAgentStockAnalyst()
            
            # 2. Inject the threading bridges using our custom method
            stock_crew.setup_websocket(
                send_message_sync=send_message_sync,
                wait_event=wait_event,
                shared_state=shared_state
            )
            
            result = stock_crew.crew().kickoff(inputs={'ticker': ticker})
            final_data = result.pydantic.model_dump() if result.pydantic else result.raw
            
            send_message_sync({"type": "complete", "data": final_data})
        except Exception as e:
            send_message_sync({"type": "error", "data": str(e)})
        try:
            send_message_sync({"type": "status", "data": f"Starting analysis for {ticker}..."})
            
            # Instantiate the crew with our threading bridges
            stock_crew = MultiAgentStockAnalyst(
                send_message_sync=send_message_sync,
                wait_event=wait_event,
                shared_state=shared_state
            )
            
            result = stock_crew.crew().kickoff(inputs={'ticker': ticker})
            final_data = result.pydantic.model_dump() if result.pydantic else result.raw
            
            send_message_sync({"type": "complete", "data": final_data})
        except Exception as e:
            send_message_sync({"type": "error", "data": str(e)})

    try:
        # Listen for messages from the frontend
        while True:
            data = await websocket.receive_json()
            
            if data.get("action") == "start":
                # User clicked "Analyze". Run the crew in a background thread.
                ticker = data.get("ticker", "AAPL")
                threading.Thread(target=run_crew, args=(ticker,)).start()
                
            elif data.get("action") == "feedback":
                # User submitted their review. Save it and wake up the Crew thread!
                shared_state['feedback'] = data.get("message")
                wait_event.set() 

    except WebSocketDisconnect:
        print("Client disconnected.")


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
        update = _normalize_live_update(message, symbol)
        if update is not None:
            _enqueue_live_update(queue, update)

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
    

@app.get("/api/tickers", response_model=TickerListResponse)
async def list_popular_tickers(limit: int = 50):
    """Ticker list from yfinance Yahoo screener (``most_actives``), with JSON/minimal fallback."""
    if limit < 1:
        limit = 1
    if limit > 250:
        limit = 250
    try:
        tickers, source = await asyncio.to_thread(_resolve_ticker_list, limit)
        return TickerListResponse(tickers=tickers, count=len(tickers), source=source)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


async def _autocomplete_handler(q: str, limit: int) -> TickerAutocompleteResponse:
    if limit < 1:
        limit = 1
    if limit > 25:
        limit = 25
    try:
        return await asyncio.to_thread(_yahoo_autocomplete, q, limit)
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
        return _stock_quote_from_history(ticker, hist)
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