# Token Streaming Architecture

## Overview

The Agentic Chatbot Accelerator uses a **dual-SNS architecture** with two Lambda functions to enable real-time streaming of tokens from Bedrock AgentCore runtime to the user interface (UI). This architecture decouples inbound request handling from outbound response delivery, providing resilience, scalability, and true real-time streaming capabilities.

---

## Complete Message Flow: User Message → UI Display

### Step 1: User Sends Message via UI

**Location:** React Frontend → AppSync GraphQL API

The user submits a message through the chat interface, which triggers a GraphQL mutation:

```graphql
mutation sendQuery($data: String) {
  sendQuery(data: $data)
}
```

**GraphQL Schema (`lib/api/schema/schema.graphql`):**
```graphql
type Mutation {
    sendQuery(data: String): String @aws_cognito_user_pools
    # ... other mutations
}
```

The `data` parameter contains a JSON string with:
```json
{
  "action": "run",
  "data": {
    "sessionId": "...",
    "messageId": "...",
    "text": "user prompt",
    "agentRuntimeId": "...",
    "qualifier": "endpoint-name"
  }
}
```

---

### Step 2: sendQuery Lambda Resolver Publishes to Inbound SNS Topic

**Lambda:** `lib/api/functions/resolvers/send-query-lambda-resolver/index.py`

This Lambda resolver is attached to the `sendQuery` mutation and publishes the message to an **Inbound SNS Topic**.

**Code Snippet:**
```python
@tracer.capture_lambda_handler
@logger.inject_lambda_context(log_event=False, correlation_id_path=correlation_paths.APPSYNC_RESOLVER)
def handler(event, _: LambdaContext):
    request = json.loads(event["arguments"]["data"])
    message = {
        "action": request["action"],
        "direction": "IN",
        "timestamp": str(int(round(datetime.now(timezone.utc).timestamp()))),
        "userId": event["identity"]["sub"],
        "data": request.get("data", {}),
        "framework": request.get("framework", "BEDROCK_MANAGED"),
    }

    try:
        response = sns.publish(TopicArn=TOPIC_ARN, Message=json.dumps(message))
        return response
    except Exception as e:
        logger.exception(e)
        raise RuntimeError("Something went wrong")
```

**Key Points:**
- Extracts user identity from Cognito (`event["identity"]["sub"]`)
- Adds metadata (timestamp, direction="IN")
- Publishes to **Inbound SNS Topic** (fire-and-forget)
- Returns immediately to client

---

### Step 3: Inbound Message Handler Lambda Invokes AgentCore Runtime

**Lambda:** `lib/genai-interface/functions/agent-core/index.py`

This Lambda is **subscribed to the Inbound SNS Topic** and processes incoming messages.

**AgentCore Runtime**: A Docker container ([lib/agent-core/docker/](../../lib/agent-core/docker/)) running a Python application ([app.py](../../lib/agent-core/docker/app.py)) using the Bedrock AgentCore Runtime framework (BedrockAgentCoreApp). It uses AWS Strands to generate responses with streaming support via AGENT.stream_async().

**Main Handler:**
```python
@event_source(data_class=SNSEvent)
@tracer.capture_lambda_handler
def handler(event: SNSEvent, _: LambdaContext) -> dict:
    for record in event.records:
        try:
            payload = load_record(record)  # Parse SNS message

            if payload.action == ChatbotAction.RUN:
                handle_run(payload)  # Main execution path
            elif payload.action == ChatbotAction.HEARTBEAT:
                handle_heartbeat(payload)
        except AcaException as err:
            # Send error to client via send_to_client()
            ...
```

**AgentCore Runtime Invocation (`handle_run`):**
```python
def handle_run(record: InputModel) -> None:
    # Validate inputs
    if record.data.text is None:
        raise AcaException("Run request must contain a prompt")

    # Get runtime version
    runtime_version = ACR_CLIENT.get_agent_runtime_endpoint(
        agentRuntimeId=record.data.agentRuntimeId,
        endpointName=record.data.qualifier,
    ).get("liveVersion", "??")

    # Invoke AgentCore Runtime (returns streaming iterator, NOT pre-generated response)
    payload = json.dumps({
        "prompt": record.data.text,
        "userId": record.userId,
        "messageId": record.data.messageId,
    }).encode()

    response = AC_CLIENT.invoke_agent_runtime(
        agentRuntimeArn=record.data.agentRuntimeId,
        runtimeSessionId=record.data.sessionId,
        runtimeUserId=record.userId,
        payload=payload,
        qualifier=record.data.qualifier,
        accountId=ACCOUNT_ID,
    )

    # Stream processing (Step 4) - tokens generated in real-time, not pre-generated
    buffer = ""
    response_data = dict()
    for chunk in response.get("response", []):
        decoded_chunk = buffer + chunk.decode("utf-8")
        events, buffer = parse_sse_events(decoded_chunk)

        for event in events:
            if event.get("action") == "final_response":
                response_data = event.get("data", {})
                logger.info("The agent returned a final response", extra={"event": event})
            elif event.get("error"):
                logger.error(event["error"])
                raise AcaException(event["error"])
            else:
                # This includes "on_new_llm_token" events - individual streaming tokens!
                logger.debug("Parsed event", extra={"event": event})

            # CRITICAL: send_to_client() called for EVERY event, including each token
            send_to_client(event)

    # Save conversation to DynamoDB
    save_conversation_exchange(...)
```

---

### Step 4: AgentCore Runtime Streams Response

The AgentCore runtime (`lib/agent-core/docker/app.py`) generates tokens **in real-time** using `AGENT.stream_async()` from AWS Strands, which streams tokens from the Bedrock model as they're generated by yielding Python event objects.

** Event Format Examples**
```
data: {"action":"on_new_llm_token","data":{"token":{"value":"Hello"}}}

data: {"action":"on_new_llm_token","data":{"token":{"value":" world"}}}

data: {"action":"final_response","data":{"content":"Hello world"}}

```

refer to [parse_event](../../lib/genai-interface/functions/agent-core/index.py#234) to understand how the client Lambda parses event from runtime.

**Event Types from AgentCore (`lib/agent-core/docker/src/types.py` - ChatbotAction enum):**

The event stream contains different event types:

1. **Individual Token Events** - Each token as it's generated in real-time
   ```json
   {
     "action": "on_new_llm_token",
     "userId": "...",
     "data": {
       "token": {
         "sequenceNumber": 1,
         "value": "Hello"
       },
       "sessionId": "..."
     }
   }
   ```

2. **Final Response Event** - Complete answer with metadata (includes reasoning if used)
   ```json
   {
     "action": "final_response",
     "data": {
       "content": "Complete answer text",
       "reasoningContent": "Full reasoning text (if reasoning model used)",
       "references": [...],
       "sessionId": "..."
     }
   }
   ```

3. **Error Events**
   ```json
   {
     "error": "Error message",
     "action": "error"
   }
   ```

**AgentCore Runtime Code (`app.py`):**
```python
# Token streaming - generated in real-time
async for event in AGENT.stream_async(user_message, ...):
    if "data" in event:
        yield {"action": ChatbotAction.ON_NEW_LLM_TOKEN.value, ...}  # "on_new_llm_token"
    elif "result" in event:
        yield {"action": ChatbotAction.FINAL_RESPONSE.value, ...}    # "final_response"
```

---

### Step 5: Send Each Event to Client via Outbound SNS Topic

**Function:** `lib/shared/layers/python-sdk/genai_core/api_helper/message_handler.py`

For each parsed event, the inbound handler calls `send_to_client()`:

```python
def send_to_client(detail: Dict, topic_arn: Optional[str] = None) -> None:
    """
    Send a message to an SNS topic.

    Args:
        detail (Dict): The message details to be sent. If "direction" is not specified,
                       it will be set to "OUT".
        topic_arn (Optional[str]): The ARN of the SNS topic to publish to. If not provided,
                                  uses the MESSAGE_TOPIC_ARN environment variable.
    """
    if not detail.get("direction"):
        detail["direction"] = "OUT"

    if not detail.get("framework"):
        detail["framework"] = "BEDROCK_MANAGED"

    if not topic_arn:
        topic_arn = os.environ["MESSAGE_TOPIC_ARN"]

    SNS_CLIENT.publish(
        TopicArn=topic_arn,
        Message=json.dumps(detail),
    )
```

**Key Point:** Each token/event is immediately published to the **Outbound SNS Topic** as it's parsed from the stream. The `send_to_client(event)` call happens for **every** event type, including individual `"on_new_llm_token"` events.

---

### Step 6: Outbound Message Handler Publishes to AppSync

**Lambda:** `lib/api/functions/outgoing-message-handler/index.ts`

This Lambda is **subscribed to the Outbound SNS Topic** and forwards messages to AppSync.

**Code:**
```typescript
const recordHandler = async (record: SNSEventRecord): Promise<void> => {
    const message = record.Sns.Message;
    if (message) {
        const req = JSON.parse(message);
        logger.debug("Processed message", req);

        const query = `
          mutation Mutation {
            publishResponse (
              data: ${JSON.stringify(message)},
              sessionId: "${req.data.sessionId}",
              userId: "${req.userId}"
            ) {
              data
              sessionId
              userId
            }
          }
      `;
        await graphQlQuery(query);
    }
};

export const handler = async (event: SNSEvent, context: Context): Promise<void> => {
    // Sort events by token sequence number for ordered delivery
    event.Records = event.Records.sort((a, b) => {
        try {
            const x: number = JSON.parse(a.Sns.Message).data?.token?.sequenceNumber;
            const y: number = JSON.parse(b.Sns.Message).data?.token?.sequenceNumber;
            return x - y;
        } catch {
            return 0;
        }
    });

    // Process each record
    for (const record of event.Records) {
        try {
            await recordHandler(record);
        } catch (error) {
            logger.error("Failed to process record", { error, record });
        }
    }
};
```

**Critical Feature:** The handler **sorts events by `sequenceNumber`** before publishing to ensure tokens arrive in the correct order, even if SNS delivers them out of sequence.

---

### Step 7: AppSync publishResponse Mutation Triggers Subscription

**GraphQL Schema:**
```graphql
type Mutation {
    publishResponse(sessionId: String, userId: String, data: String): Channel @aws_iam
}

type Subscription {
    receiveMessages(sessionId: String): Channel
        @aws_subscribe(mutations: ["publishResponse"])
        @aws_cognito_user_pools
}

type Channel @aws_iam @aws_cognito_user_pools {
    data: String
    sessionId: String
    userId: String
}
```

**AppSync Resolver:** `lib/api/functions/resolvers/publish-response-resolver.js`

This is a **NONE data source resolver** that simply returns the input, triggering the subscription:

```javascript
export function request(ctx) {
    return {
        payload: ctx.args
    };
}

export function response(ctx) {
    return ctx.result;
}
```

---

### Step 8: Client Receives Tokens via GraphQL Subscription

The React frontend subscribes to `receiveMessages`:

```typescript
const subscription = API.graphql({
    query: `
        subscription ReceiveMessages($sessionId: String) {
            receiveMessages(sessionId: $sessionId) {
                data
                sessionId
                userId
            }
        }
    `,
    variables: { sessionId: currentSessionId }
});

subscription.subscribe({
    next: ({ value }) => {
        const event = JSON.parse(value.data.receiveMessages.data);

        if (event.action === "on_new_llm_token") {
            // Append each streaming token as it arrives
            appendToken(event.data.token.value);
        } else if (event.action === "tool_action") {
            // Display tool action notification in thinking panel
            displayToolAction(event.data.toolAction, event.data.invocationNumber);
        } else if (event.action === "final_response") {
            // Mark message as complete, handle reasoning if present
            finalizeMessage(event.data);
            if (event.data.reasoningContent) {
                displayReasoningContent(event.data.reasoningContent);
            }
        }
    }
});
```

---

## Streaming Tokens vs Final Response

### Distinction

The system handles two phases of response generation:

1. **Streaming Tokens** (Real-time generation)
   - Event action: `"on_new_llm_token"`
   - Individual tokens streamed as the model generates them
   - Displayed incrementally in real-time to the user
   - Each token sent via `send_to_client()` immediately upon generation

2. **Final Response** (Completion)
   - Event action: `"final_response"`
   - Complete answer with metadata (content, references, reasoning)
   - Reasoning content (if model used extended thinking) included in `reasoningContent` field
   - Stored in DynamoDB history with both `content` and optional `reasoningContent`

### Storage in Session History

**From `lib/genai-interface/functions/agent-core/index.py`:**

```python
def save_conversation_exchange(
    ai_response: str,  # Final answer content
    record: InputModel,
    reasoning_content: str,  # Thinking/reasoning content
    references: Optional[str],
    runtime_id: str,
    runtime_version: str,
    endpoint_name: str,
) -> None:
    history_handler = ChatHistoryHandler(...)

    # Save user message
    user_prompt = ChatbotMessage.init_from_string(
        messageId=record.data.messageId,
        message=record.data.text
    )
    history_handler.add_message_to_chat(message=user_prompt, render=True, ...)

    # Save assistant response with separate reasoning
    assistant_response = ChatbotMessage.init_from_string(
        messageId=record.data.messageId,
        message=ai_response,  # Final answer
        role=ERole.ASSISTANT
    )

    parsed_refs = json.loads(references) if references else None
    history_handler.add_message_to_chat(
        message=assistant_response,
        render=True,
        references=parsed_refs,
        reasoning_content=reasoning_content  # Separate field
    )
```

### UI Display

**From `lib/api/functions/http-api-handler/routes/sessions.py`:**

When fetching session history, both contents are retrieved separately:

```python
history_item = {
    "type": item.get("type"),
    "content": data.get("content"),  # Final answer
    "messageId": item.get("messageId"),
    "complete": True,
}

# Reasoning content added as separate field
if "reasoningContent" in data:
    history_item["reasoningContent"] = data["reasoningContent"]
```

---

## Hook-Based Tool Action Notifications

### Overview

The system uses **AWS Strands Hooks** to provide real-time, user-friendly notifications when the agent invokes tools. This improves UX by explaining what the agent is doing in non-technical terms.

### How It Works

**3-Stage Pipeline**: Hook Capture → AI Translation → UI Delivery

#### Stage 1: Hook Registration

**Location**: `lib/agent-core/docker/src/factory.py`

When creating the agent, a hook is registered for the `BeforeToolCallEvent`:

```python
agent.hooks.add_callback(BeforeToolCallEvent, callbacks.log_tool_entries)
```

This callback fires **before** any tool is invoked, allowing the system to capture tool metadata in real-time.

#### Stage 2: Tool Invocation Notification

**Location**: `lib/agent-core/docker/src/callbacks.py` - `log_tool_entries()` method

When a tool is about to be invoked, the callback:

1. Extracts tool specifications (name, description, parameters with schemas)
2. Increments invocation counter for ordering
3. Publishes message to dedicated **Agent Tools SNS Topic**:

```python
message = {
    "context": {
        "userId": self._user_id,
        "sessionId": self._session_id,
        "invocationNumber": self._nb_tool_invocations,
    },
    "data": {
        "toolName": event.tool_use.get("name"),
        "toolDescription": specs.get("description"),
        "parameters": [...]  # Detailed parameter info
    }
}

SNS_CLIENT.publish(
    TopicArn=AGENT_TOOLS_TOPIC_ARN,
    Message=json.dumps(message),
    Subject="AgentToolInvocation",
)
```

**Key Point**: Non-blocking - doesn't slow down tool execution.

#### Stage 3: AI-Powered Translation

**Location**: `lib/genai-interface/functions/agent-tools-handler/index.py`

A dedicated Lambda subscribes to the Agent Tools SNS Topic and:

1. Receives tool invocation message
2. Calls a fast, cheap foundation model (Mistral Ministral 3) with a system prompt
3. Generates user-friendly description (e.g., "Looking up order #123...")
4. Publishes to Outbound SNS Topic via `send_to_client()`

```python
response = CLIENT.converse(
    modelId="mistral.ministral-3-8b-instruct",
    messages=[{"role": "user", "content": [{"text": tool_data}]}],
    system=[{"text": SYS_PROMPT}],
    inferenceConfig={"maxTokens": 1024, "temperature": 0.2}
)

send_to_client({
    "action": "tool_action",
    "data": {
        "sessionId": session_id,
        "toolAction": response_text,  # User-friendly description
        "toolName": tool_name,
        "invocationNumber": invocation_number,
    }
})
```

#### Stage 4: UI Delivery

The `tool_action` event follows the existing message flow:
- Outbound SNS → Outbound Lambda → AppSync → GraphQL Subscription → UI

**Event Structure**:
```json
{
  "action": "tool_action",
  "data": {
    "sessionId": "...",
    "toolAction": "Checking the weather in Paris...",
    "toolName": "get_weather",
    "invocationNumber": 1
  }
}
```

### Benefits

1. **Model-Independent**: Works with any foundation model
2. **User-Friendly**: AI translates technical details into plain language
3. **Real-Time**: Notifications appear as tools execute
4. **Non-Blocking**: Doesn't affect agent performance
5. **Ordered**: Invocation numbers ensure proper sequencing
6. **Cheap**: Uses fast, inexpensive model for translation

### Example Flow

User asks: "What's the weather in Paris?"

1. Agent decides to use `get_weather` tool
2. `BeforeToolCallEvent` hook fires
3. Callback publishes to Agent Tools SNS: `{toolName: "get_weather", parameters: [{name: "city", value: "Paris"}]}`
4. Translation Lambda receives message
5. Mistral generates: "Checking the weather in Paris..."
6. UI receives `tool_action` event → displays in real-time

User sees: **"🔄 Checking the weather in Paris..."** before receiving the actual weather data.

---

## Architecture Diagram

```
┌─────────────┐
│  React UI   │
│  (Browser)  │
└──────┬──────┘
       │ 1. GraphQL Mutation: sendQuery
       ▼
┌──────────────────────────────────┐
│      AWS AppSync GraphQL API     │
│  (+ Cognito User Pool Auth)      │
└──────┬───────────────────────────┘
       │ 2. Lambda Resolver
       ▼
┌──────────────────────────────────┐
│   sendQuery Lambda Resolver      │
│  ├─ Parse message                │
│  ├─ Add metadata (userId, time)  │
│  └─ Publish to SNS               │
└──────┬───────────────────────────┘
       │ 3. SNS Publish
       ▼
┌──────────────────────────────────┐
│     Inbound SNS Topic            │
└──────┬───────────────────────────┘
       │ 4. Lambda Trigger
       ▼
┌──────────────────────────────────┐
│  Inbound Message Handler Lambda  │
│  ├─ Parse SNS event              │
│  ├─ Invoke AgentCore Runtime ────┼─────────┐
│  ├─ Stream runtime events        │         │
│  ├─ Parse events                 │         │
│  └─ send_to_client() for each    │         │
└──────┬───────────────────────────┘         │
       │                                      │
       │ 5. For each token/event              │ 5a. AgentCore
       ▼                                      │     Runtime
┌──────────────────────────────────┐         │     Invocation
│  send_to_client() Function       │         │
│  └─ Publish to Outbound SNS      │         ▼
└──────┬───────────────────────────┘   ┌────────────────┐
       │ 6. SNS Publish                │  Bedrock       │
       ▼                               │  AgentCore     │
┌──────────────────────────────────┐   │  Runtime       │
│    Outbound SNS Topic            │   │  (Docker       │
└──────┬───────────────────────────┘   │  Container)    │
       │ 7. Lambda Trigger              └────────────────┘
       ▼
┌──────────────────────────────────┐
│ Outbound Message Handler Lambda  │
│  ├─ Sort by sequenceNumber       │
│  ├─ Call AppSync mutation        │
│  └─ publishResponse              │
└──────┬───────────────────────────┘
       │ 8. GraphQL Mutation
       ▼
┌──────────────────────────────────┐
│      AWS AppSync GraphQL API     │
│  publishResponse Mutation        │
│  Triggers: receiveMessages       │
└──────┬───────────────────────────┘
       │ 9. GraphQL Subscription Event
       ▼
┌─────────────┐
│  React UI   │ ← Token displayed in real-time
│  (Browser)  │
└─────────────┘
```

---

## Key Architectural Benefits

### 1. Decoupling
The inbound handler doesn't wait for AppSync delivery - it fires tokens to SNS and continues processing. This prevents blocking and improves throughput.

### 2. Resilience
If AppSync temporarily fails, SNS automatically retries delivery to the outbound handler, ensuring no tokens are lost.

### 3. Ordering
The outbound handler sorts events by sequence number before publishing to AppSync, maintaining correct token order even if SNS delivers them out of sequence.

### 4. Scalability
SNS handles fan-out and buffering between components, allowing the system to scale horizontally without coordination between Lambda functions.

### 5. Real-time Streaming
Tokens stream to the UI as they're generated by AgentCore, providing instant feedback to users and creating a responsive chat experience.

### 6. Separation of Concerns
- **Inbound Handler**: Focused on AgentCore invocation and agent event parsing
- **Outbound Handler**: Focused on AppSync delivery and ordering
- Each Lambda can be optimized, monitored, and scaled independently

---

## Component Summary

| Component | Type | Responsibility |
|-----------|------|----------------|
| React UI | Frontend | User interface, message submission, token display |
| AppSync GraphQL API | API Gateway | Authentication, mutation/subscription routing |
| sendQuery Lambda | Resolver | Publish user messages to Inbound SNS |
| Inbound SNS Topic | Message Queue | Decouple API from processing |
| Inbound Message Handler | Lambda | Invoke AgentCore, parse agent events, publish tokens |
| AgentCore Runtime | Docker Container | Generate AI responses via AWS Strands, trigger hooks |
| Agent Tools SNS Topic | Message Queue | Distribute tool invocation notifications |
| agent-tools-handler Lambda | Lambda | Translate tool actions to user-friendly text |
| send_to_client() | Helper Function | Publish events to Outbound SNS |
| Outbound SNS Topic | Message Queue | Buffer and distribute all events (tokens, tool actions) |
| Outbound Message Handler | Lambda | Sort events, publish to AppSync |
| publishResponse Mutation | AppSync | Trigger subscription notifications |
| receiveMessages Subscription | AppSync | Real-time event delivery to clients |

---

## Error Handling

Each component implements comprehensive error handling:

1. **sendQuery Lambda**: Catches exceptions and returns generic error message to protect sensitive information
2. **Inbound Handler**: Catches `AcaException` and sends user-friendly error via `send_to_client()`
3. **Outbound Handler**: Continues processing other records if one fails
4. **AgentCore**: Returns error events in stream events with specific error messages

All errors are logged with AWS Lambda Powertools for observability and debugging.
