# backend/src/multi_agent_stock_analyst/crew.py

from crewai import Agent, Crew, Process, Task, LLM
from crewai.project import CrewBase, agent, crew, task
from crewai_tools import TXTSearchTool 
from .tools.custom_tool import crew_price_tool, crew_news_tool
from .tools.human_tool import HumanFeedbackTool
from .models import PriceAnalysis, FinalReport
from dotenv import load_dotenv
import os

load_dotenv()
MODEL = os.getenv('MODEL', 'gpt-5.4')

PREF_FILE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "knowledge", "user_preference.txt")

# Initialize the RAG tool
user_pref_rag_tool = TXTSearchTool(txt=PREF_FILE_PATH) if os.path.exists(PREF_FILE_PATH) else None

@CrewBase
class MultiAgentStockAnalyst():
    agents_config = 'config/agents.yaml'
    tasks_config = 'config/tasks.yaml'

    def answer_follow_up(self, question: str, report_context: dict) -> str:
        """Spins up a lightweight, single-agent crew to answer follow-up questions."""
        
        # 1. Define a dynamic task on the fly
        qa_task = Task(
            description=(
                f"You are a helpful financial advisor. Read the following investment report context:\n"
                f"{report_context}\n\n"
                f"Now, answer the client's specific follow-up question: '{question}'\n"
                f"Be conversational, highly accurate to the report, and concise."
            ),
            expected_output="A direct, helpful plain-text answer to the client's question.",
            agent=self.knowledge_advisor() # We reuse your existing advisor agent!
        )
        
        # 2. Create a mini-crew with just the advisor
        chat_crew = Crew(
            agents=[self.knowledge_advisor()],
            tasks=[qa_task],
            verbose=True
        )
        
        # 3. Kick it off and return the raw text
        result = chat_crew.kickoff()
        return result.raw


    def setup_websocket(self, send_message_sync, wait_event, shared_state):
        self.human_tool = HumanFeedbackTool(
            send_message_sync=send_message_sync,
            wait_event=wait_event,
            shared_state=shared_state
        )

    @agent
    def crew_manager(self) -> Agent:
        return Agent(
            config=self.agents_config['crew_manager'],
            allow_delegation=True,
            llm=LLM(model=MODEL, temperature=0), 
            verbose=True,
        )

    @agent
    def knowledge_advisor(self) -> Agent:
        rag_tools = [user_pref_rag_tool] if user_pref_rag_tool else []
        return Agent(
            config=self.agents_config['knowledge_advisor'],
            tools=rag_tools, 
            verbose=True
        )

    @agent
    def price_analyst(self) -> Agent:
        return Agent(config=self.agents_config['price_analyst'], tools=[crew_price_tool])

    @agent
    def news_analyst(self) -> Agent:
        return Agent(config=self.agents_config['news_analyst'], tools=[crew_news_tool])

    @agent
    def report_writer(self) -> Agent:
        return Agent(
            config=self.agents_config['report_writer']
        )

    # ---> ADD THE NEW BLIND AGENT <---
    @agent
    def json_compiler(self) -> Agent:
        return Agent(
            config=self.agents_config['json_compiler']
        )

    @task
    def consult_knowledge_task(self) -> Task:
        return Task(
            config=self.tasks_config['consult_knowledge_task'],
            agent=self.knowledge_advisor(),
        )

    @task
    def analyze_price_task(self) -> Task:
        return Task(
            config=self.tasks_config['analyze_price_task'],
            agent=self.price_analyst(), 
            output_pydantic=PriceAnalysis
        )

    @task
    def analyze_news_task(self) -> Task:
        return Task(
            config=self.tasks_config['analyze_news_task'],
            agent=self.news_analyst(),
        )

    # ---> 1. THE DRAFTING TASK (No Tool) <---
    @task
    def draft_report_task(self) -> Task:
        return Task(
            config=self.tasks_config['draft_report_task'],
            agent=self.report_writer()
        )

    # ---> 2. THE REVIEW TASK (Has Tool, Takes Draft Context) <---
    @task
    def review_report_task(self) -> Task:
        tools = [self.human_tool] if hasattr(self, 'human_tool') else []
        return Task(
            config=self.tasks_config['review_report_task'],
            agent=self.report_writer(),
            tools=tools,
            context=[self.draft_report_task()] # Only sees the first draft
        )

    # ---> 3. THE FORMATTING TASK (No Tool, Takes Reviewed Context, Outputs Pydantic) <---
    @task
    def format_json_task(self) -> Task:
        return Task(
            config=self.tasks_config['format_json_task'],
            agent=self.json_compiler(),          
            context=[self.review_report_task()], 
            output_pydantic=FinalReport
        )

    @crew
    def crew(self) -> Crew:
        return Crew(
            # ---> ADD THE NEW AGENT TO THE ROSTER <---
            agents=[
                self.knowledge_advisor(), 
                self.price_analyst(), 
                self.news_analyst(), 
                self.report_writer(), 
                self.json_compiler() 
            ], 
            tasks=[
                self.consult_knowledge_task(),
                self.analyze_price_task(),
                self.analyze_news_task(),
                self.draft_report_task(),     
                self.review_report_task(),    
                self.format_json_task()       
            ],

            process=Process.hierarchical,
            manager_agent=self.crew_manager(),

            tracing=True,
            verbose=True,
            memory=True 
        )