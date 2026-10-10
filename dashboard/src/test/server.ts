import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { Server, User } from "@/api/types";

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
  );
}

export const apiError = (status: number, code: string, message: string) =>
  HttpResponse.json({ error: { code, message } }, { status });
