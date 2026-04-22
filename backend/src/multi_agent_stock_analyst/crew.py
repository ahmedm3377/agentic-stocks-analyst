# backend/src/multi_agent_stock_analyst/crew.py

import json
import os
from typing import Any

from crewai import Agent, Crew, Process, Task, LLM
from crewai.events.event_bus import crewai_event_bus
from crewai.events.types.task_events import TaskStartedEvent
from crewai.project import CrewBase, agent, crew, task
from crewai.tasks.task_output import TaskOutput
from crewai_tools import TXTSearchTool
from dotenv import load_dotenv

from .tools.custom_tool import crew_price_tool, crew_news_tool
from .tools.human_tool import HumanFeedbackTool
from .models import PriceAnalysis, FinalReport

load_dotenv()
MODEL = os.getenv('MODEL', 'gpt-5.4')
# Memory/RAG must use an embeddings API model, not the chat MODEL (403 if misrouted).
OPENAI_EMBEDDING_MODEL = os.getenv('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small')

PREF_FILE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "knowledge", "user_preference.txt")

# Initialize the RAG tool
user_pref_rag_tool = TXTSearchTool(txt=PREF_FILE_PATH) if os.path.exists(PREF_FILE_PATH) else None

# Cap payload size for WebSocket JSON (full trace still in terminal if verbose=True)
_MAX_TASK_OUTPUT_WS_CHARS = int(os.getenv('CREW_TASK_OUTPUT_WS_MAX_CHARS', '16000'))


def _text_from_task_output(output: TaskOutput) -> str:
    if output.raw:
        return output.raw
    if output.summary:
        return output.summary
    if output.pydantic is not None:
        if hasattr(output.pydantic, 'model_dump_json'):
            return output.pydantic.model_dump_json(indent=2)
        return str(output.pydantic)
    if output.json_dict:
        return json.dumps(output.json_dict, indent=2, default=str)
    return ''


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
        self._send_ws = send_message_sync

    def kickoff_analysis(self, inputs: dict) -> Any:
        """Run the crew and emit ``task_started`` over WebSocket when each task begins."""
        send = getattr(self, '_send_ws', None)
        crew_instance = self.crew()

        def on_task_started(_source: Any, event: TaskStartedEvent) -> None:
            if send is None:
                return
            task = event.task
            if task is None:
                return
            task_name = task.name or 'task'
            if task_name == 'format_json_task':
                return
            agent = task.agent
            agent_role = getattr(agent, 'role', None) if agent is not None else None
            if not agent_role:
                agent_role = 'Agent'
            send({
                'type': 'task_started',
                'data': {
                    'task_name': task_name,
                    'agent_role': agent_role,
                },
            })

        crewai_event_bus.on(TaskStartedEvent)(on_task_started)
        try:
            return crew_instance.kickoff(inputs=inputs)
        finally:
            crewai_event_bus.off(TaskStartedEvent, on_task_started)

    def _emit_task_output_ws(self, output: TaskOutput) -> None:
        send = getattr(self, '_send_ws', None)
        if send is None:
            return
        text = _text_from_task_output(output)
        truncated = False
        if len(text) > _MAX_TASK_OUTPUT_WS_CHARS:
            text = text[:_MAX_TASK_OUTPUT_WS_CHARS] + '\n… [truncated for WebSocket; see server logs for full output]'
            truncated = True
        task_name = output.name or 'task'
        agent_role = output.agent or 'agent'
        send({
            'type': 'task_output',
            'data': {
                'task_name': task_name,
                'agent_role': agent_role,
                'output': text,
                'truncated': truncated,
            },
        })

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
        crew_self = self

        def on_task_completed(output: TaskOutput) -> None:
            crew_self._emit_task_output_ws(output)

        return Crew(
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
            memory=True,
            task_callback=on_task_completed,
            embedder={
                'provider': 'openai',
                'config': {'model_name': OPENAI_EMBEDDING_MODEL},
            },
        )