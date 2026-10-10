import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, type Page } from "@playwright/test";
import { CONTROL_PORT } from "../ports.js";

const control = `http://127.0.0.1:${CONTROL_PORT}`;

export interface HarnessState {
  admin: { email: string; password: string; apiKey: string };
  gatewayUrl: string;
  fakes: { alpha: string; beta: string };
}

export async function harness(): Promise<HarnessState> {
  return (await fetch(`${control}/state`)).json() as Promise<HarnessState>;
}

export async function setFakeBehavior(
  name: "alpha" | "beta",
  behavior: "ok" | "hang" | "unauthorized" | "http500",
) {
  await fetch(`${control}/fakes/${name}/behavior`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ behavior }),
  });
}

/** Authorization headers a fake upstream has received from the gateway. */
export async function fakeAuthHeaders(name: "alpha" | "beta"): Promise<(string | null)[]> {
  return (await fetch(`${control}/fakes/${name}/auth`)).json() as Promise<(string | null)[]>;
}

/** Short unique suffix, so re-runs and retries never collide on slugs or emails. */
export const unique = () => Math.random().toString(36).slice(2, 8);

export async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "MCP servers" })).toBeVisible();
}

/**
 * An external MCP client - standing in for Claude Code / Cursor - that knows
 * only the gateway URL and an API key.
 */
export async function mcpClient(key: string) {
  const { gatewayUrl } = await harness();
  const client = new Client({ name: "e2e-client", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  );
  return client;
}

export async function toolNames(key: string): Promise<string[]> {
  const client = await mcpClient(key);
  try {
    return (await client.listTools()).tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}

const adminHeaders = (apiKey: string) => ({
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
});

/** Calls the gateway's REST API as the bootstrap admin (API key: no cookie, no CSRF Origin). */
export async function adminApi<T>(path: string, init: { method?: string; body?: unknown } = {}) {
  const { admin, gatewayUrl } = await harness();
  const res = await fetch(`${gatewayUrl}/api${path}`, {
    method: init.method ?? "GET",
    headers: adminHeaders(admin.apiKey),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> HTTP ${res.status}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** A member who can log in right away (invite created and accepted through the API). */
export async function createMember() {
  const { gatewayUrl } = await harness();
  const email = `member-${unique()}@e2e.test`;
  const password = "member-password-123";
  const created = await adminApi<{ inviteUrl: string }>("/users", {
    method: "POST",
    body: { name: "Bea Member", email, role: "member" },
  });
  const token = created.inviteUrl.split("/invite/")[1];
  const res = await fetch(`${gatewayUrl}/api/auth/invites/${token}/accept`, {
    method: "POST",
    // Cookie-less, but login/accept still demand the dashboard's Origin.
    headers: { "Content-Type": "application/json", Origin: "http://localhost:4173" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error(`accept invite -> HTTP ${res.status}`);
  return { email, password };
}
