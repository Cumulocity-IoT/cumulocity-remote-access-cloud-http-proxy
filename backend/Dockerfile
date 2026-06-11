# syntax=docker/dockerfile:1

# ---- Build stage: compile a static musl binary ----
FROM rust:1-alpine AS build

# Build dependencies for crates with native code (ring needs a C compiler + perl). The
# rust:alpine image already targets the musl libc.
RUN apk add --no-cache build-base perl

WORKDIR /usr/src/app

# Cache dependency compilation: build against a stub main, then drop it in for the real sources.
COPY backend/Cargo.toml ./
COPY backend/Cargo.lock* ./
RUN mkdir src \
    && echo "fn main() {}" > src/main.rs \
    && cargo build --release \
    && rm -rf src

COPY backend/src ./src
# Ensure the real sources are seen as newer than the stub build.
RUN touch src/main.rs && cargo build --release

# ---- Runtime stage ----
FROM alpine:3.23.4 AS production

RUN addgroup -g 1000 node \
    && adduser -u 1000 -G node -s /bin/sh -D node

COPY --from=build /usr/src/app/target/release/cloud-http-proxy /usr/local/bin/cloud-http-proxy

USER node

EXPOSE 80

CMD [ "/usr/local/bin/cloud-http-proxy" ]
