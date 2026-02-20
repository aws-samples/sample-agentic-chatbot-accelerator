# Expanding the AI Tools Family

This guide explains how scientists and ML engineers can extend the Agentic Chatbot Accelerator with custom AI tools to enhance agent capabilities.

## Architecture Overview

The tool system consists of three main components:

1. **Tool Registry** - DynamoDB table storing tool metadata
2. **Tool Factory** - Creates tool instances from configurations
3. **Tool Implementation** - Python classes defining tool behavior

## Tool Types

### MCP-Based Tools
Model Context Protocol (MCP) servers provide external tool capabilities that can be integrated into your agents. To include MCP server tools, you need to create an MCP server **in the same AWS region and account used to deploy the agentic-chatbot-accelerator stack.**

#### Supported MCP Hosting Options
The system supports two types of MCP hosting options:

- **AgentCore Runtime** - Host your MCP server on Bedrock AgentCore Runtime with AWS IAM for Inbound Authorization. [Example](https://github.com/awslabs/amazon-bedrock-agentcore-samples/blob/main/01-tutorials/01-AgentCore-runtime/02-hosting-MCP-server/hosting_mcp_server_iam_auth.ipynb)

- **AgentCore Gateway** - Host your MCP server on Bedrock AgentCore Gateway with AWS IAM for Inbound Authorization. [Example](https://github.com/awslabs/amazon-bedrock-agentcore-samples/blob/main/01-tutorials/02-AgentCore-gateway/01-transform-lambda-into-mcp-tools/02-gateway-target-lambda-iam.ipynb).


#### Setting Up MCP Server

To create MCP servers for your agents, you'll need to set up a dedicated workspace and choose between two hosting approaches.

**Initial Setup:**
- Create a main workspace folder: `CustomMcpServer`
- Choose your hosting approach: AgentCore Runtime or AgentCore Gateway
- Create a subfolder for your chosen approach within `CustomMcpServer`

**Setting Up AgentCore Runtime MCP Server**

To set up your MCP server on AgentCore Runtime, use [this comprehensive notebook guide](https://github.com/awslabs/amazon-bedrock-agentcore-samples/blob/main/01-tutorials/01-AgentCore-runtime/02-hosting-MCP-server/hosting_mcp_server_iam_auth.ipynb).

Setup Steps:
- Create subfolder: `CustomMcpServer/runtime/`
- Copy required files from the public GitHub repo into the runtime subfolder:
  - [hosting_mcp_server_iam_auth.ipynb](https://github.com/awslabs/amazon-bedrock-agentcore-samples/blob/main/01-tutorials/01-AgentCore-runtime/02-hosting-MCP-server/hosting_mcp_server_iam_auth.ipynb)
  - [requirements.txt](https://github.com/awslabs/amazon-bedrock-agentcore-samples/blob/main/01-tutorials/01-AgentCore-runtime/02-hosting-MCP-server/requirements.txt)
  - [streamable_http_sigv4.py](https://github.com/awslabs/amazon-bedrock-agentcore-samples/blob/main/01-tutorials/01-AgentCore-runtime/02-hosting-MCP-server/streamable_http_sigv4.py)
- Run the steps given in the notebook

These steps will create an MCP server in AgentCore Runtime.

**Setting Up AgentCore Gateway MCP Server**

To set up your MCP server on AgentCore Gateway, use [this comprehensive notebook guide](https://github.com/awslabs/amazon-bedrock-agentcore-samples/blob/main/01-tutorials/02-AgentCore-gateway/01-transform-lambda-into-mcp-tools/02-gateway-target-lambda-iam.ipynb).

Setup Steps:
- Create subfolder: `CustomMcpServer/gateway/`
- Copy required files from the public GitHub repo into the gateway subfolder:
  - [02-gateway-target-lambda-iam.ipynb](https://github.com/awslabs/amazon-bedrock-agentcore-samples/blob/main/01-tutorials/02-AgentCore-gateway/01-transform-lambda-into-mcp-tools/02-gateway-target-lambda-iam.ipynb)
  - [requirements.txt](https://github.com/awslabs/amazon-bedrock-agentcore-samples/blob/main/01-tutorials/02-AgentCore-gateway/01-transform-lambda-into-mcp-tools/requirements.txt)
  - [utils.py](https://github.com/awslabs/amazon-bedrock-agentcore-samples/blob/main/01-tutorials/02-AgentCore-gateway/utils.py)
  - [streamable_http_sigv4.py](https://github.com/awslabs/amazon-bedrock-agentcore-samples/blob/main/01-tutorials/02-AgentCore-gateway/01-transform-lambda-into-mcp-tools/streamable_http_sigv4.py)
  - [lambda_function_code.zip](https://github.com/awslabs/amazon-bedrock-agentcore-samples/blob/main/01-tutorials/02-AgentCore-gateway/01-transform-lambda-into-mcp-tools/lambda_function_code.zip)
- Run the steps given in the notebook

These steps will create an MCP server on AgentCore Gateway using AWS Lambda functions as tools.


#### Configuration
**Add** MCP server details in the `bin/config.yaml` file. The MCP URL is automatically composed at deployment time based on the runtime or gateway ID you provide, along with the AWS region and account ID from your deployment context.

For each MCP server, you must specify exactly one of:
- **runtimeId**: The runtime identifier from your AgentCore Runtime deployment (visible in the AgentCore console or returned when creating the runtime)
- **gatewayId**: The gateway identifier from your AgentCore Gateway deployment

Optional parameters:
- **qualifier**: The endpoint qualifier for Runtime deployments (defaults to `DEFAULT` if not specified)

```yaml
# Example MCP server configuration
mcpServerRegistry:
    - name: mcp_server_runtime
      runtimeId: mcp_server_iam-abcd9876      # Runtime ID from AgentCore deployment
      qualifier: DEFAULT                       # Optional, defaults to "DEFAULT"
      description: Example MCP server deployed on Agentcore Runtime
    - name: mcp_server_gateway
      gatewayId: test-xywz1234                 # Gateway ID from AgentCore deployment
      description: Example MCP server deployed on Agentcore Gateway
```

The system automatically constructs the full MCP URL during CDK deployment:
- **Runtime**: `https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{encoded-arn}/invocations?qualifier={qualifier}`
- **Gateway**: `https://{gatewayId}.gateway.bedrock-agentcore.{region}.amazonaws.com/mcp`


### Function-Based Tools
Simple tools implemented as decorated Python functions:

```python
@tool(description="Tool description")
def my_tool(param1: str, param2: int = 1) -> str:
    """Tool implementation"""
    return result
```

### Object-Based Tools
Complex tools requiring configuration, inheriting from `AbstractToolObject`:

```python
class MyTool(AbstractToolObject):
    def __init__(self, config_param: str):
        super().__init__(
            description="Tool description",
            name="my_tool"
        )
        self._config = config_param

    def _tool_implementation(self, query: str) -> str:
        # Tool logic here
        return result
```

## Adding New Custom Tools

### 1. Implement Tool Logic

Add your tool to [lib/agent-core/docker/src/registry.py](../../lib/agent-core/docker/src/registry.py):

```python
# Function-based example
@tool(description="Analyze scientific data")
def analyze_data(dataset_path: str, analysis_type: str) -> dict:
    """Performs scientific data analysis"""
    # Implementation
    return {"results": analysis_results}

# Object-based example
class MLModelTool(AbstractToolObject):
    def __init__(self, model_endpoint: str, model_type: str):
        super().__init__(
            description=f"Invoke {model_type} ML model for predictions",
            name=f"ml_model_{model_type}"
        )
        self._endpoint = model_endpoint

    def _tool_implementation(self, input_data: str) -> dict:
        # Call ML model endpoint
        response = invoke_model(self._endpoint, input_data)
        return {"prediction": response}
```

### 2. Register Tool Factory

Add factory method to `ToolFactory` class:

```python
class ToolFactory:
    @staticmethod
    def create_analyze_data() -> Callable:
        return analyze_data

    @staticmethod
    def create_ml_model_tool(model_endpoint: str, model_type: str) -> Callable:
        tool_instance = MLModelTool(model_endpoint, model_type)
        return tool_instance.tool
```

### 3. Update Factory Mapping

Add to `TOOL_FACTORY_MAP`:

```python
TOOL_FACTORY_MAP = {
    "analyze_data": ToolFactory.create_analyze_data,
    "ml_model_tool": ToolFactory.create_ml_model_tool,
    # ... existing tools
}
```

### 4. Register in Configuration

Create a `config.yaml` in [bin/ folder](../../bin/) folder with your custom toolRegistry:

```yaml
toolRegistry:
  - name: "get_current_time"
    description: "Get the current date and time in the specified timezone. Helpful when user refers to relative time (yesterday, today, this year, now, etc.)"
    invokesSubAgent: false
  - name: "invoke_subagent"
    description: "Invoke a sub-agent to handle specialized tasks or domain-specific queries that require dedicated processing"
    invokesSubAgent: true
  - name: "analyze_data"
    description: "Analyze scientific datasets with statistical methods",
    invokesSubAgent: false,
  - name: "ml_model_tool"
    description: "Invoke ML models for predictions and analysis",
    invokesSubAgent: false,
    # ... existing tools
```

## Advanced Tool Patterns

### AWS Service Integration

```python
class S3AnalysisTool(AbstractToolObject):
    def __init__(self, bucket_name: str):
        super().__init__(
            description="Analyze data stored in S3",
            name="s3_analysis"
        )
        self._s3_client = boto3.client('s3')
        self._bucket = bucket_name

    def _tool_implementation(self, s3_key: str) -> dict:
        # Download and analyze S3 object
        obj = self._s3_client.get_object(Bucket=self._bucket, Key=s3_key)
        data = obj['Body'].read()
        results = perform_analysis(data)
        return {"analysis": results}
```

### External API Integration

```python
class ExternalAPITool(AbstractToolObject):
    def __init__(self, api_endpoint: str, api_key: str):
        super().__init__(
            description="Query external scientific API",
            name="external_api"
        )
        self._endpoint = api_endpoint
        self._headers = {"Authorization": f"Bearer {api_key}"}

    def _tool_implementation(self, query: str) -> dict:
        response = requests.post(
            self._endpoint,
            json={"query": query},
            headers=self._headers
        )
        return response.json()
```

### Context-Aware Tools

Tools that need access to conversation context:

```python
class ContextAwareTool(AbstractToolObject):
    def __init__(self):
        super().__init__(
            description="Tool that uses conversation context",
            name="context_tool",
            context=True  # Enable context access
        )

    def _tool_implementation(self, query: str, tool_context: ToolContext) -> str:
        user_id = tool_context.invocation_state.get("userId")
        session_id = tool_context.invocation_state.get("sessionId")
        # Use context in tool logic
        return result
```

## Deployment

After implementing new tools:

1. **Build and deploy** the updated Docker container
2. **Update CDK configuration** with new tool registry entries
3. **Deploy infrastructure** changes via CDK
4. **Create a new AgentCore Runtime** through the *Agent Factory*
5. **Test tools** through the *Chatbot Experience*

## Tool Discovery

Tools are automatically discovered through:

- DynamoDB tool registry scan
- Factory mapping lookup
- Runtime tool initialization

The system supports up to 100 registered tools with pagination for larger registries.
