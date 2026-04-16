from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from src.multi_agent_stock_analyst.crew import MultiAgentStockAnalyst
from src.multi_agent_stock_analyst.models import (
    BasicIndicators,
    MarketBehaviorSummary,
    StockQuoteChanges,
    StockQuoteResponse,
    UserPreferences,
)
import asyncio
import threading
import uvicorn
from dotenv import load_dotenv
import os
import yfinance as yf
from newsapi import NewsApiClient

load_dotenv()



PREF_FILE_PATH = "knowledge/user_preference.txt"

VOLUME_UNUSUAL_RATIO = 1.5


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