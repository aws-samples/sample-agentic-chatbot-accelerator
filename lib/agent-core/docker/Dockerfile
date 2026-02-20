FROM public.ecr.aws/docker/library/python:3.13-slim
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY src/ src/.

ENV DOCKER_CONTAINER=1
ENV OTEL_LOGS_EXPORTER=none

RUN useradd -m -u 1000 bedrock_agentcore
USER bedrock_agentcore

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f  || exit 1

CMD ["opentelemetry-instrument", "python", "app.py"]
