# ---- Builder stage: resolve dependencies into an isolated venv ----
# uv and any install-time artifacts stay here and never reach the final image.
FROM public.ecr.aws/docker/library/python:3.13-slim AS builder
WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
# uv syncs the locked dependency set into this venv; the runtime stage copies it.
# UV_COMPILE_BYTECODE precompiles .pyc at build time — see the strip step below.
ENV UV_PROJECT_ENVIRONMENT=/opt/venv
ENV UV_COMPILE_BYTECODE=1

# uv.lock pins every transitive dependency; --locked fails the build if the
# lock is stale (e.g. pyproject.toml changed without re-running `uv lock`).
# The botocore-without-[crt] override (awscrt conflict workaround) lives in
# pyproject.toml's [tool.uv].
COPY docker-agents-as-tools/pyproject.toml docker-agents-as-tools/uv.lock ./
RUN uv sync --locked --no-dev --no-cache

# Strip bundled test suites (never imported at runtime)
RUN find /opt/venv \( -type d -name tests -o -type d -name test \) -prune -exec rm -rf {} +

# ---- Runtime stage: copy only the venv + app code ----
FROM public.ecr.aws/docker/library/python:3.13-slim
WORKDIR /app

# Same base image guarantees the venv's interpreter path stays valid.
COPY --from=builder /opt/venv /opt/venv
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="/opt/venv/bin:$PATH"

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
