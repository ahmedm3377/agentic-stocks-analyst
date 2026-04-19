
from crewai.tools import BaseTool
from pydantic import Field, ConfigDict
import threading
from typing import Callable

class HumanFeedbackTool(BaseTool):
    name: str = "Ask Human for Review"
    description: str = (
        "Pass the draft report to this tool. It will pause execution, "
        "ask the human for feedback, and return their instructions. "
        "Only use this ONCE when the draft is ready."
    )
    
    # REQUIRED: Tells Pydantic not to crash when it sees Callable and threading.Event
    model_config = ConfigDict(arbitrary_types_allowed=True)

    # We use exclude=True so Pydantic doesn't try to serialize these runtime objects
    send_message_sync: Callable = Field(exclude=True) 
    wait_event: threading.Event = Field(exclude=True)
    shared_state: dict = Field(exclude=True)

    def _run(self, draft_report: str) -> str:
        # Clear any stale feedback
        self.shared_state.pop('feedback', None)

        # 1. Send the draft to the frontend
        try:
            self.send_message_sync({
                "type": "review_needed", 
                "data": draft_report
            })
        except Exception as e:
            print(f"WEBSOCKET FAILED: {e}")
            return "Error connecting to user. Assume draft is approved."
        
        # 2. Pause the thread
        self.wait_event.clear()
        event_set = self.wait_event.wait(timeout=300) 
        
        if not event_set:
            return "The user did not respond in time. Assume the draft is approved and finalize it."
        
        # 3. Get the user's feedback
        user_feedback = self.shared_state.get('feedback', 'Looks good, proceed.')
        
        
        # We wrap the feedback in a strict command so the LLM cannot ignore it.
        return (
            f"USER FEEDBACK: {user_feedback}\n\n"
            f"CRITICAL SYSTEM COMMAND: You are not done yet! You must now generate your Final Answer. "
            f"You MUST completely rewrite the draft right now to execute the user's instructions exactly. "
            f"Apply every constraint, formatting rule, length limit, or stylistic change requested in the feedback above. "
            f"Do not just repeat your old draft. Output the NEWLY REWRITTEN text."
        )