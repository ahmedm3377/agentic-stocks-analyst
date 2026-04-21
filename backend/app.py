from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import asyncio
import threading
import uvicorn
from dotenv import load_dotenv
import os
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

# WebSocket route for crew runs — client must connect here (see frontend `ANALYZE_WEBSOCKET_PATH`).
ANALYZE_WEBSOCKET_PATH = "/api/analyze"

PREF_FILE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "knowledge", "user_preference.txt")


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

@app.websocket(ANALYZE_WEBSOCKET_PATH)
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    
    # These variables manage the cross-thread communication
    wait_event = threading.Event()
    shared_state = {}

    # Capture the main thread's event loop HERE
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
    def run_crew(ticker: str, user_query: str = ""):
        try:
            # Update status message based on whether it's a standard analysis or a custom query
            if user_query:
                send_message_sync({"type": "status", "data": f"Processing query for {ticker}: {user_query}..."})
            else:
                send_message_sync({"type": "status", "data": f"Starting full analysis for {ticker}..."})
            
            # 1. Instantiate the crew completely empty to avoid decorator bugs
            stock_crew = MultiAgentStockAnalyst()
            
            # 2. Inject the threading bridges using our custom method
            stock_crew.setup_websocket(
                send_message_sync=send_message_sync,
                wait_event=wait_event,
                shared_state=shared_state
            )
            
            # 3. Pass BOTH the ticker and the custom user query into the Crew inputs
            inputs = {
                'ticker': ticker,
                'user_query': user_query
            }
            
            # Kickoff the hierarchical manager
            result = stock_crew.crew().kickoff(inputs=inputs)
            
            # Extract the data and send it back
            final_data = result.pydantic.model_dump() if result.pydantic else result.raw
            send_message_sync({"type": "complete", "data": final_data})
            
        except Exception as e:
            send_message_sync({"type": "error", "data": str(e)})

    try:
        # Listen for messages from the frontend
        while True:
            data = await websocket.receive_json()
            action = data.get("action")
            
            if action == "start":
                # User requested an analysis or asked a question
                ticker = data.get("ticker", "AAPL")
                user_query = data.get("query", "") # Extract custom query if provided
                
                # Run the crew in a background thread
                threading.Thread(target=run_crew, args=(ticker, user_query)).start()
                
            elif action == "feedback":
                # User submitted their review. Save it and wake up the Crew thread!
                shared_state['feedback'] = data.get("message")
                wait_event.set() 
            
            elif action == "chat":
                # User is asking a question about the finished report
                question = data.get("question")
                report_context = data.get("context") 
                
                def run_chat():
                    try:
                        send_message_sync({"type": "status", "data": "Consulting advisor..."})
                        stock_crew = MultiAgentStockAnalyst()
                        
                        # Call our new mini-crew method
                        answer = stock_crew.answer_follow_up(question, report_context)
                        
                        # Send the answer back to the UI
                        send_message_sync({"type": "chat_response", "data": answer})
                    except Exception as e:
                        send_message_sync({"type": "error", "data": str(e)})

                # Run the chat in a background thread so the socket doesn't block
                threading.Thread(target=run_chat).start()

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