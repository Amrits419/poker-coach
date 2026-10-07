# ── Build stage ──────────────────────────────────────────────────────────
FROM rust:1.83-slim AS builder

WORKDIR /app

# System deps needed to build postflop-solver's git dependency + rayon
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    libssl-dev \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Cache dependency compilation separately from source changes
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release && rm -rf src

COPY src ./src
# touch main.rs so cargo actually rebuilds it (mtime from COPY can be older
# than the cached dummy build's output)
RUN touch src/main.rs && cargo build --release

# ── Runtime stage ────────────────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 1000 appuser

COPY --from=builder /app/target/release/solver-service /usr/local/bin/solver-service

USER appuser
EXPOSE 3002
ENV BIND_ADDR=0.0.0.0:3002

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
    CMD ["/bin/sh", "-c", "wget -qO- http://127.0.0.1:3002/health || exit 1"]

CMD ["solver-service"]
