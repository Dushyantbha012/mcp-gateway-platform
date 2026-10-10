# Build from the repo root (the workspace lockfile lives there):
#   docker build -f woocommerce-mcp/Dockerfile -t mcp-gateway/woocommerce-mcp:dev .

# --- build: install all deps, compile TypeScript ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY woocommerce-mcp/package.json woocommerce-mcp/
COPY gateway/package.json gateway/
COPY dashboard/package.json dashboard/
RUN npm ci --workspace woocommerce-mcp --include-workspace-root --ignore-scripts
COPY woocommerce-mcp/ woocommerce-mcp/
RUN npm run build --workspace woocommerce-mcp

# --- deps: production dependencies only ---
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY woocommerce-mcp/package.json woocommerce-mcp/
COPY gateway/package.json gateway/
COPY dashboard/package.json dashboard/
RUN npm ci --workspace woocommerce-mcp --omit=dev --ignore-scripts

# --- runtime: compiled JS + prod deps, non-root ---
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/woocommerce-mcp/dist woocommerce-mcp/dist
COPY woocommerce-mcp/package.json woocommerce-mcp/
USER node
EXPOSE 3000
CMD ["node", "woocommerce-mcp/dist/index.js"]
