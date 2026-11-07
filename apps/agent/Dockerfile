# Rust agent image (root build context, Cargo workspace).
FROM rust:1-slim AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY apps/agent ./apps/agent
COPY apps/compiler ./apps/compiler
COPY apps/edge ./apps/edge
RUN cargo build --release --locked -p resolvezero-agent --bin resolvezero-agent

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --no-create-home resolvezero-agent || true
COPY --from=build /app/target/release/resolvezero-agent /usr/local/bin/resolvezero-agent
EXPOSE 53/udp 53/tcp
ENTRYPOINT ["/usr/local/bin/resolvezero-agent"]
