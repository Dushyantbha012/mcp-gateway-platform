# Build from the repo root (the workspace lockfile lives there):
#   docker build -f mcp-bridge/Dockerfile -t mcp-gateway/mcp-bridge:dev .
#
# The image carries the bridge as self-contained binaries (Bun's runtime is
# compiled in), one per libc, for the architecture being built. A hosted MCP
# server's pod copies the right one into a shared volume from an init
# container, so the bridge runs inside any image: Python, Go, Node, ...

# --- deps: the locked production dependencies (npm, so the lockfile holds) ---
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY mcp-bridge/package.json mcp-bridge/
RUN npm ci --workspace mcp-bridge --omit=dev --ignore-scripts

# --- build: compile to standalone executables ---
FROM oven/bun:1.2.23 AS build
ARG TARGETARCH
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY mcp-bridge/src mcp-bridge/src
RUN arch=$([ "$TARGETARCH" = "amd64" ] && echo x64 || echo arm64) && \
    bun build mcp-bridge/src/index.ts --compile --minify --target=bun-linux-$arch --outfile /out/mcp-bridge-glibc && \
    bun build mcp-bridge/src/index.ts --compile --minify --target=bun-linux-$arch-musl --outfile /out/mcp-bridge-musl

# --- runtime: just the binaries, and a cp for the init container ---
FROM busybox:1.37.0-musl
COPY --from=build /out/ /opt/mcp-bridge/
USER 1000:1000
# `install-bridge glibc /bridge` from the pod spec copies the chosen binary.
COPY --chmod=0755 <<'SH' /usr/local/bin/install-bridge
#!/bin/sh
set -eu
libc="${1:-glibc}"; dest="${2:-/bridge}"
cp "/opt/mcp-bridge/mcp-bridge-$libc" "$dest/mcp-bridge"
chmod 0555 "$dest/mcp-bridge"
SH
ENTRYPOINT ["/usr/local/bin/install-bridge"]
