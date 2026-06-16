# ---- Builder stage: resolve dependencies into an isolated venv ----
# uv and any install-time artifacts stay here and never reach the final image.
FROM public.ecr.aws/docker/library/python:3.13-slim AS builder
WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
# uv syncs the locked dependency set into this venv; the runtime stage copies it.
ENV UV_PROJECT_ENVIRONMENT=/opt/venv

# uv.lock pins every transitive dependency; --locked fails the build if the
# lock is stale (e.g. pyproject.toml changed without re-running `uv lock`).
COPY docker-graph/pyproject.toml docker-graph/uv.lock ./
RUN uv sync --locked --no-dev --no-cache

# ---- Runtime stage: copy only the venv + app code ----
FROM public.ecr.aws/docker/library/python:3.13-slim
WORKDIR /app

# Same base image guarantees the venv's interpreter path stays valid.
COPY --from=builder /opt/venv /opt/venv
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY docker-graph/app.py .
COPY docker-graph/src/ src/.
COPY shared/ shared/.

ENV DOCKER_CONTAINER=1

RUN useradd -m -u 1000 bedrock_agentcore
USER bedrock_agentcore

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f  || exit 1

CMD ["opentelemetry-instrument", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
