# --- Build stage ---
FROM golang:1.26.8-alpine AS builder

RUN apk add --no-cache git

WORKDIR /src

# Cache dependencies
COPY server/go.mod server/go.sum ./server/
RUN cd server && go mod download

# Copy server source
COPY server/ ./server/

# Build binaries
ARG VERSION
ARG COMMIT
ARG DATE
RUN test -n "$VERSION" && test -n "$COMMIT" && test -n "$DATE"
RUN cd server && for command in server multica migrate backfill_task_usage_hourly backfill_codex_usage_cache; do \
      CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION} -X main.commit=${COMMIT} -X main.date=${DATE}" \
        -o "bin/$command" "./cmd/$command" || exit 1; \
    done && go version -m bin/* > bin/go-build-info.txt

# --- Runtime stage ---
FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app

ARG VERSION
ARG COMMIT
ARG DATE
LABEL org.opencontainers.image.source="https://github.com/AstralSolipsism/multica" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$COMMIT \
      org.opencontainers.image.created=$DATE

COPY --from=builder /src/server/bin/server .
COPY --from=builder /src/server/bin/multica .
COPY --from=builder /src/server/bin/migrate .
COPY --from=builder /src/server/bin/backfill_task_usage_hourly .
COPY --from=builder /src/server/bin/backfill_codex_usage_cache .
COPY --from=builder /src/server/bin/go-build-info.txt .
COPY server/migrations/ ./migrations/
COPY LICENSE NOTICE ./
COPY docker/entrypoint.sh .
RUN sed -i 's/\r$//' entrypoint.sh && chmod +x entrypoint.sh && \
    sha256sum server multica migrate backfill_task_usage_hourly backfill_codex_usage_cache \
      LICENSE NOTICE entrypoint.sh go-build-info.txt migrations/* > checksums.txt

EXPOSE 8080

ENTRYPOINT ["./entrypoint.sh"]
