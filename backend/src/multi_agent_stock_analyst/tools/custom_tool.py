from crewai.tools import tool
from .mcp_server import get_stock_price_data, get_recent_news

@tool("Stock Price Tool")
def crew_price_tool(ticker: str) -> str:
    """Gets the latest price and volume data for a stock."""
    return get_stock_price_data(ticker)

@tool("Stock News Tool")
def crew_news_tool(ticker: str) -> str:
    """Gets recent news headlines for a stock."""
    return get_recent_news(ticker)