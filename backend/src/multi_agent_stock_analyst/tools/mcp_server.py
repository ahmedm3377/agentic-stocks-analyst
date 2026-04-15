import os
from fastmcp import FastMCP
import yfinance as yf
from newsapi import NewsApiClient

mcp = FastMCP("StockMarketTools")

# Initialize NewsAPI using the key from your .env file
newsapi = NewsApiClient(api_key=os.getenv("NEWSAPI_KEY"))

@mcp.tool()
def get_stock_price_data(ticker: str) -> str:
    """Fetch recent price and volume data for a given ticker."""
    stock = yf.Ticker(ticker)
    hist = stock.history(period="1mo")
    if hist.empty:
        return f"No data found for {ticker}."
    
    latest = hist.iloc[-1]
    return f"Current Price: {latest['Close']:.2f}, Volume: {latest['Volume']}"

@mcp.tool()
def get_recent_news(ticker: str) -> str:
    """Fetch recent news headlines for the ticker."""
    try:
        # Search for articles related to the ticker
        all_articles = newsapi.get_everything(
            q=ticker,
            language='en',
            sort_by='relevancy',
            page_size=5 # Limit to top 5 to keep the LLM context window clean
        )
        
        if all_articles['status'] == 'ok' and all_articles['totalResults'] > 0:
            headlines = [article['title'] for article in all_articles['articles']]
            return f"Recent headlines for {ticker}: " + " | ".join(headlines)
        else:
            return f"No major recent news found for {ticker}."
            
    except Exception as e:
        return f"Error fetching news: {str(e)}"