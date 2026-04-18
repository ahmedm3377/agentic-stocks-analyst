from crewai import Agent, Crew, Process, Task, LLM
from crewai.project import CrewBase, agent, crew, task
from .tools.custom_tool import crew_price_tool, crew_news_tool
from .tools.human_tool import HumanFeedbackTool
from .models import PriceAnalysis, FinalReport
from dotenv import load_dotenv
import os

load_dotenv()
MODEL = os.getenv('MODEL', 'gpt-5.4-mini')



@CrewBase
class MultiAgentStockAnalyst():
    agents_config = 'config/agents.yaml'
    tasks_config = 'config/tasks.yaml'

    def setup_websocket(self, send_message_sync, wait_event, shared_state):
        self.human_tool = HumanFeedbackTool(
            send_message_sync=send_message_sync,
            wait_event=wait_event,
            shared_state=shared_state
        )

    # --- THE MANAGER AGENT ---
    @agent
    def crew_manager(self) -> Agent:
        return Agent(
            config=self.agents_config['crew_manager'],
            allow_delegation=True,
            llm=LLM(model=MODEL, temperature=0),
            verbose=True
        )

    # --- THE WORKER AGENTS ---
    @agent
    def price_analyst(self) -> Agent:
        return Agent(config=self.agents_config['price_analyst'], tools=[crew_price_tool])

    @agent
    def news_analyst(self) -> Agent:
        return Agent(config=self.agents_config['news_analyst'], tools=[crew_news_tool])

    @agent
    def report_writer(self) -> Agent:
        tools = [self.human_tool] if hasattr(self, 'human_tool') else []
        return Agent(
            config=self.agents_config['report_writer'],
            tools=tools
        )

    # --- THE TASKS (Unbound from specific agents so the Manager can delegate) ---
    @task
    def analyze_price_task(self) -> Task:
        return Task(
            config=self.tasks_config['analyze_price_task'],
            output_pydantic=PriceAnalysis
        )

    @task
    def analyze_news_task(self) -> Task:
        return Task(
            config=self.tasks_config['analyze_news_task']
        )

    @task
    def write_report_task(self) -> Task:
        return Task(
            config=self.tasks_config['write_report_task'],
            output_pydantic=FinalReport
        )

    # --- THE CREW ---
    @crew
    def crew(self) -> Crew:
        return Crew(
            agents=[self.price_analyst(), self.news_analyst(), self.report_writer()],
            tasks=self.tasks,
            tracing=True,
            verbose=True,
            process=Process.hierarchical,
            manager_agent=self.crew_manager() 
        )