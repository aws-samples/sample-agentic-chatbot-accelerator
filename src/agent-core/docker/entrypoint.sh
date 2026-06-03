#!/usr/bin/env bash
# Container entrypoint that selects the FastAPI app and listen port based on
# `agentcoreServerProtocol`. AgentCore Runtime requires HTTP on port 8080 and
# A2A on port 9000, mounted at "/" — and one runtime serves only one protocol.
# We use a single image and let IaC inject the env var per twin runtime.
set -euo pipefail

protocol="${agentcoreServerProtocol:-HTTP}"
protocol="${protocol^^}"

if [[ "$protocol" == "A2A" ]]; then
    target="app:a2a_app"
    port=9000
else
    target="app:app"
    port=8080
fi

echo "[entrypoint] protocol=${protocol} target=${target} port=${port}"
exec opentelemetry-instrument uvicorn "$target" --host 0.0.0.0 --port "$port"
