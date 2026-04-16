from typing import Literal

from pydantic import BaseModel, Field

class PriceAnalysis(BaseModel):
    trend: str = Field(..., description="bullish, bearish, or mixed")
    price_change_30d: float = Field(..., description="Percentage change over 30 days")
    volume_signal: str = Field(..., description="normal, high, or low")
    summary: str = Field(..., description="Short summary of price action")

class FinalReport(BaseModel):
    ticker: str
    market_view: str
    trend: str
    key_catalysts: list[str]
    bull_case: str
    bear_case: str
    main_risks: list[str]
    confidence_level: str

class UserPreferences(BaseModel):
    risk_tolerance: str
    investment_horizon: str
    preferences: str


class MarketBehaviorSummary(BaseModel):
    """Short structured view for a market-behavior-focused agent or UI."""

    trend: Literal["bullish", "bearish", "mixed"]
    momentum: Literal["weak", "moderate", "strong"]
    unusual_activity: bool


class StockQuoteChanges(BaseModel):
    """Approximate session returns: day = last vs prior close; week ≈ 5 sessions; month ≈ 21 sessions."""

    day: float | None = None
    week: float | None = None
    month: float | None = None


class BasicIndicators(BaseModel):
    sma_5: float | None = None
    sma_20: float | None = None


class StockQuoteResponse(BaseModel):
    ticker: str
    price: float
    currency: str = "USD"
    changes_pct: StockQuoteChanges
    volume_vs_20d_avg: float | None = Field(
        default=None,
        description="Latest volume divided by the average of the prior 20 sessions (>1.5 often reads as unusual).",
    )
    indicators: BasicIndicators
    summary: MarketBehaviorSummary


class TickerEntry(BaseModel):
    symbol: str
    name: str


class TickerListResponse(BaseModel):
    """Curated symbols for dropdowns and offline-friendly lists."""

    tickers: list[TickerEntry]
    count: int
    source: str = "curated"


class TickerSuggestion(BaseModel):
    symbol: str
    name: str
    exchange: str | None = None
    kind: str | None = Field(default=None, description="e.g. EQUITY, ETF")


class TickerAutocompleteResponse(BaseModel):
    """Query-based matches (Yahoo Finance search)."""

    suggestions: list[TickerSuggestion]