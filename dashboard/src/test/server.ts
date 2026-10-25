import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { Hosted, Server, User } from "@/api/types";

export const server = setupServer();

export const admin: User = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "admin@example.com",
  name: "Ada Admin",
  role: "admin",
  createdAt: new Date().toISOString(),
  disabledAt: null,
  hasPassword: true,
};

export const member: User = {
  ...admin,
  id: "22222222-2222-2222-2222-222222222222",
  email: "member@example.com",
  name: "Max Member",
  role: "member",
};

export function serverFixture(overrides: Partial<Server> = {}): Server {
  return {
    id: "33333333-3333-3333-3333-333333333333",
    slug: "woocommerce",
    name: "WooCommerce",
    url: "http://woo.internal/mcp",
    enabled: true,
    status: "connected",
    lastError: null,
    lastCheckedAt: new Date().toISOString(),
    authType: "bearer",
    authHeaderName: null,
    hasCredential: true,
    timeoutMs: 10_000,
    readOnly: false,
    managedBy: null,
    tools: [
      {
        name: "woocommerce__list_orders",
        upstreamName: "list_orders",
        description: "[WooCommerce] List orders",
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Handlers for a logged-in user; add page-specific ones with server.use(). */
export function loggedInAs(user: User) {
  server.use(
    http.get("/api/me", () => HttpResponse.json(user)),
    http.get("/api/meta", () =>
      HttpResponse.json({ mcpUrl: "http://gateway.test/mcp", chatEnabled: true }),
    ),
    // Hosting off unless a test says otherwise (admins only ask).
    http.get("/api/hosted", () =>
      HttpResponse.json({ enabled: false, imageAllowlist: [], servers: [] }),
    ),
  );
}

export const apiError = (status: number, code: string, message: string) =>
  HttpResponse.json({ error: { code, message } }, { status });

export function hostedFixture(overrides: Partial<Hosted> = {}): Hosted {
  return {
    id: "44444444-4444-4444-4444-444444444444",
    slug: "thinking",
    name: "Sequential thinking",
    image: "mcp/sequentialthinking@sha256:cd3174b2",
    transport: "stdio",
    command: ["node", "dist/index.js"],
    port: 8080,
    path: "/mcp",
    libc: "musl",
    env: {},
    secretEnvKeys: [],
    authTokenEnv: null,
    egress: "none",
    size: "small",
    status: "provisioning",
    step: "server",
    reason: null,
    namespace: "mcp-thinking",
    serverId: null,
    createdBy: { id: admin.id, email: admin.email },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}
