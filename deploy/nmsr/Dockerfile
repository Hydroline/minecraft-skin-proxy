FROM rust:slim-bookworm AS builder

ARG NMSR_REV=948ba4bc027b7a5a67d583b98982c1f95ddb3645

WORKDIR /src

RUN apt-get update -y \
  && apt-get install --no-install-recommends -y ca-certificates git libssl-dev pkg-config \
  && rm -rf /var/lib/apt/lists/*

RUN git clone https://github.com/NickAcPT/nmsr-rs.git . \
  && git checkout "$NMSR_REV"

# Do not use target-cpu=native here: the binary is compiled on CNB but runs on
# a different production CPU. Rust's portable x86-64 baseline is intentional.
RUN cargo build --release --bin nmsr-aas --features ears --package nmsr-aas

FROM debian:bookworm-slim

RUN apt-get update -y \
  && apt-get install --no-install-recommends -y ca-certificates mesa-vulkan-drivers \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /nmsr

COPY --from=builder /src/target/release/nmsr-aas /nmsr/nmsr-aas
COPY config.toml /nmsr/config.toml

ENV NMSR_SAMPLE_COUNT=1
ENV NMSR_USE_SMAA=1
ENV RUST_BACKTRACE=1
ENV WGPU_BACKEND=vulkan

RUN chmod +x /nmsr/nmsr-aas

EXPOSE 8080

CMD ["/nmsr/nmsr-aas", "-c", "/nmsr/config.toml"]
