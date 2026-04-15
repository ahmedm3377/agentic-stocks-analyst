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