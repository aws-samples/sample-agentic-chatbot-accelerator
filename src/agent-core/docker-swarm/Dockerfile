FROM public.ecr.aws/docker/library/python:3.13-slim
WORKDIR /app

COPY docker-swarm/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY docker-swarm/app.py .
COPY docker-swarm/src/ src/.
COPY shared/ shared/.

ENV DOCKER_CONTAINER=1

RUN useradd -m -u 1000 bedrock_agentcore
USER bedrock_agentcore

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f  || exit 1

CMD ["opentelemetry-instrument", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
