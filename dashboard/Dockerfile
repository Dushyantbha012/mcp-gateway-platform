# Build from the repo root (the workspace lockfile lives there):
#   docker build -f dashboard/Dockerfile -t mcp-gateway/dashboard:dev .

# --- build: install deps, type-check and bundle ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY woocommerce-mcp/package.json woocommerce-mcp/
COPY gateway/package.json gateway/
COPY dashboard/package.json dashboard/
RUN npm ci --workspace dashboard --include-workspace-root --ignore-scripts
COPY dashboard/ dashboard/
RUN npm run build --workspace dashboard

# --- runtime: static files on nginx, non-root (uid 101), port 8080 ---
FROM nginxinc/nginx-unprivileged:1.30.5-alpine
ENV NGINX_ENTRYPOINT_QUIET_LOGS=1
COPY dashboard/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY dashboard/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/dashboard/dist /usr/share/nginx/html
EXPOSE 8080
