# Build from the repo root (the workspace lockfile lives there):
#   docker build -f gateway/Dockerfile -t mcp-gateway/gateway:dev .

# --- build: install all deps, compile TypeScript ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY woocommerce-mcp/package.json woocommerce-mcp/
COPY gateway/package.json gateway/
COPY dashboard/package.json dashboard/
RUN npm ci --workspace gateway --include-workspace-root --ignore-scripts
COPY gateway/ gateway/
RUN npm run build --workspace gateway

# --- deps: production dependencies only ---
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY woocommerce-mcp/package.json woocommerce-mcp/
COPY gateway/package.json gateway/
COPY dashboard/package.json dashboard/
RUN npm ci --workspace gateway --omit=dev --ignore-scripts

# --- runtime: compiled JS + prod deps, non-root ---
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/gateway/dist gateway/dist
COPY gateway/package.json gateway/
# The provisioner (same image, `node gateway/dist/provisioner/main.js`) installs
# stores with the Helm chart's own bootstrap scripts.
COPY helm/charts/store/files gateway/store-files
USER node
EXPOSE 8080
CMD ["node", "gateway/dist/index.js"]
