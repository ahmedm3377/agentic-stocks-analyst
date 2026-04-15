from crewai.tools import BaseTool
from pydantic import Field
import threading
from typing import Any, Callable

class HumanFeedbackTool(BaseTool):
    name: str = "Ask Human for Review"
    description: str = "Pass the draft report to this tool. It will pause execution, ask the human for feedback, and return their instructions. Only use this ONCE when the draft is ready."
    
    # We use exclude=True so Pydantic doesn't try to serialize these runtime objects
    send_message_sync: Callable = Field(exclude=True) 
    wait_event: threading.Event = Field(exclude=True)
    shared_state: dict = Field(exclude=True)

    def _run(self, draft_report: str) -> str:
        # 1. Send the draft to the frontend via the provided callback
        self.send_message_sync({
            "type": "review_needed", 
            "data": draft_report
        })
        
        # 2. Pause this specific thread until the WebSocket receives a reply
        self.wait_event.clear()
        self.wait_event.wait() 
        
        # 3. Wake up and return the human's feedback to the Agent
        return self.shared_state.get('feedback', 'Looks good, proceed.')