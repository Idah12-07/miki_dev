# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# miki-payment production image.
#
# Stage 1 builds the release binary on a Debian-based Rust toolchain image.
# Stage 2 ships only the binary + CA roots on debian:bookworm-slim.
#
# The runtime binary dynamically links only glibc/libgcc (TLS is rustls, no
# OpenSSL), so bookworm-slim matches the builder's glibc exactly.
#
# No .env and no secrets are copied into either stage: configuration is
# supplied at runtime via environment variables (SERVER_PORT, DB_*, BTCPAY_*).
# ---------------------------------------------------------------------------

# --- Stage 1: builder -------------------------------------------------------
FROM rust:1.91.1-bookworm AS builder

WORKDIR /app

# Dependency layer. Manifests plus the compile-time embedded migrations are
# copied first with a placeholder binary so `cargo build` compiles and caches
# every dependency here; this layer is only rebuilt when Cargo.toml/Cargo.lock
# change. `--locked` guarantees the build uses Cargo.lock as committed.
COPY Cargo.toml Cargo.lock ./
COPY migrations ./migrations
RUN mkdir -p src \
    && printf 'fn main() {}\n' > src/main.rs \
    && cargo build --release --locked

# Application layer: only the crate itself is recompiled from here on.
# `COPY` preserves the mtimes of the build context, so the sources arrive
# *older* than the placeholder binary built above. Cargo's freshness check
# would then treat the crate as unchanged and ship the placeholder `fn main() {}`
# stub (an empty binary that exits 0 immediately -> Railway 502). Touching the
# sources first marks them newer than the artifact, forcing a real recompile.
COPY src ./src
RUN find src -name '*.rs' -exec touch {} + \
    && cargo build --release --locked \
    && strip target/release/miki-payment

# --- Stage 2: runtime -------------------------------------------------------
FROM debian:bookworm-slim

# ca-certificates: sqlx may load native roots for TLS to MariaDB/BTCPay.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin miki \
    && mkdir -p /app

COPY --from=builder /app/target/release/miki-payment /usr/local/bin/miki-payment

# Port the API listens on (SERVER_PORT defaults to 3000 in src/config.rs).
ENV SERVER_PORT=3000 \
    RUST_LOG=info

EXPOSE 3000

USER miki

ENTRYPOINT ["/usr/local/bin/miki-payment"]
