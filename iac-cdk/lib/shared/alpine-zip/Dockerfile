FROM alpine:3.22.1
RUN apk add zip
RUN adduser --system --no-create-home appuser

USER appuser

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD zip --version || exit 1
