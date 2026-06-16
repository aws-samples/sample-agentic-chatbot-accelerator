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
COPY docker/pyproject.toml docker/uv.lock ./
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

COPY docker/app.py .
COPY docker/src/ src/.
COPY docker/entrypoint.sh .
COPY shared/ shared/.

ENV DOCKER_CONTAINER=1

RUN chmod +x ./entrypoint.sh

RUN useradd -m -u 1000 bedrock_agentcore
USER bedrock_agentcore

# AgentCore HTTP runtimes listen on 8080; A2A twins listen on 9000. The same
# image serves both — entrypoint.sh selects via `agentcoreServerProtocol`.
EXPOSE 8080 9000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f  || exit 1

CMD ["./entrypoint.sh"]
