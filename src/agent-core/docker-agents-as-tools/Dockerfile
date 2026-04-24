FROM public.ecr.aws/docker/library/python:3.13-slim
WORKDIR /app

COPY docker-agents-as-tools/requirements.txt .
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
# Override: install botocore WITHOUT [crt] extra to avoid awscrt version conflict
# between mcp-proxy-for-aws (needs awscrt==0.31.2 via botocore[crt])
# and strands-agents[bidi] (needs awscrt~=0.28.2 via aws-sdk-bedrock-runtime)
# CRT is a performance optimization, not required for correctness.
RUN uv pip install --system --no-cache --prerelease=allow --override /dev/stdin -r requirements.txt <<'EOF'
botocore>=1.42.86
EOF

COPY docker-agents-as-tools/app.py .
COPY docker-agents-as-tools/src/ src/.
COPY shared/ shared/.

ENV DOCKER_CONTAINER=1

RUN useradd -m -u 1000 bedrock_agentcore
USER bedrock_agentcore

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f  || exit 1

CMD ["opentelemetry-instrument", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
