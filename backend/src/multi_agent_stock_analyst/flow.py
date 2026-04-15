from crewai.flow.flow import Flow, listen, start
from pydantic import BaseModel
from .crew import MultiAgentStockAnalyst

# 1. Define the state for your Flow
class AnalysisState(BaseModel):
    ticker: str = ""
    final_report: dict = {}

# 2. Create the Flow class
class StockAnalysisFlow(Flow[AnalysisState]):

    @start()
    def initialize_analysis(self):
        print(f"Starting analysis flow for: {self.state.ticker}")
        # You could add pre-processing logic here (e.g., validate the ticker)
        return self.state.ticker

    @listen(initialize_analysis)
    def run_crew(self, ticker):
        # Instantiate your CLI-generated CrewBase class
        stock_crew = MultiAgentStockAnalyst()
        
        # Kickoff the crew with the ticker
        result = stock_crew.crew().kickoff(inputs={'ticker': ticker})
        
        # Extract the structured Pydantic output
        self.state.final_report = result.pydantic.model_dump() if result.pydantic else result.raw
        
        return self.state.final_report