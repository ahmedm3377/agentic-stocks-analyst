# WebSocket API Integration Guide: Agentic Stock Analyst

This guide explains how to connect to, use, and test the CrewAI multi-agent WebSocket endpoint using Postman.

## 🔗 Endpoint Details
- **Protocol**: WebSocket (`ws://`)
- **URL**: `ws://127.0.0.1:8000/api/analyze` *(assuming default local Uvicorn port)*

---

## 🛠️ Step 1: Set Up Postman for WebSockets
1. Open Postman.
2. Click **New** > **WebSocket**.
3. In the URL bar, enter: `ws://127.0.0.1:8000/api/analyze`
4. Click **Connect**. (You should see a "Connected" message in the lower console).
5. Ensure the message format is set to **JSON**.

---

## 🚀 Step 2: The Core Analysis Flow (Human-in-the-Loop)

The primary workflow requires a back-and-forth interaction. The backend will pause and wait for user feedback before generating the final JSON report.

### 1. Trigger the Analysis
Send the `start` action to wake up the agents and begin the research phase.

**Send Message:**
```json
{
    "action": "start",
    "ticker": "TSLA",
    "query": "What are the latest news catalysts for this stock?"
}

```

###  2. Wait for the Draft
The server will stream status messages while the agents work. Eventually, it will send a review_needed payload containing the plain-text draft.

Expected Server Response:

```JSON
{
    "type": "review_needed",
    "data": "MARKET VIEW:\nTSLA appears suitable only for a cautious... [rest of draft]"
}
```
### 3. Send Human Feedback
The backend is now paused. Read the draft and send your feedback using the feedback action. The agents will rewrite the draft based exactly on these instructions.

Send Message:

```JSON
{
    "action": "feedback",
    "message": "Rewrite the entire report to be extremely concise. Limit the key_catalysts to only 3 bullet points, and make the bull_case just one short sentence."
}

```
### 4. Receive Final JSON Report
The formatting agent will convert the approved draft into strict JSON. The connection will remain open for follow-up questions.

Expected Server Response:

```JSON
{
    "type": "complete",
    "data": {
        "ticker": "TSLA",
        "market_view": "...",
        "trend": "...",
        "key_catalysts": ["...", "...", "..."],
        "bull_case": "...",
        "bear_case": "...",
        "main_risks": ["..."],
        "confidence_level": "..."
    }


```
### Step 3: The Follow-Up Chat Flow
Once the report is complete, you can ask the Knowledge Advisor questions about the report without running the entire analysis pipeline again.

1. Ask a Question
Send the chat action, passing in the user's question and the data object you received from the complete payload.

Send Message:

```JSON
{
    "action": "chat",
    "question": "What exactly do they mean by 'Optimus skepticism' in the bear case?",
    "context": {
        "ticker": "TSLA",
        "market_view": "...",
        "bear_case": "...",
        "main_risks": ["..."]
    }
}
2. Receive the Answer
The advisor will return a conversational string.

Expected Server Response:

```JSON
{
    "type": "chat_response",
    "data": "Optimus skepticism refers to doubts among investors regarding Tesla's ability to successfully commercialize its humanoid robot..."
}