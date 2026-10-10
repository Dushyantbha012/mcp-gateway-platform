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
