import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const NS = process.env.NAMESPACE ?? "urumi";
const MCP_DEPLOYMENT = process.env.MCP_DEPLOYMENT ?? "platform-store-woocommerce-mcp";
const email = process.env.E2E_ADMIN_EMAIL;
const password = process.env.E2E_ADMIN_PASSWORD;

const kubectl = (...args: string[]) =>
  execFileSync("kubectl", ["-n", NS, ...args], { stdio: "pipe" });

test.skip(
  !email || !password,
  "set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD (verify-phase4.sh does)",
);

test("live: admin sees WooCommerce Connected; killing its MCP pod shows Unreachable, then it recovers", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email!);
  await page.getByLabel("Password").fill(password!);
  await page.getByRole("button", { name: "Log in" }).click();

  const card = page.getByTestId("server-woocommerce");
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: /tools/ }).click();
  for (const tool of [
    "list_products",
    "create_product",
    "list_orders",
    "get_order",
    "update_order_status",
  ]) {
    await expect(card.getByText(`woocommerce__${tool}`)).toBeVisible();
  }

  try {
    kubectl("scale", `deployment/${MCP_DEPLOYMENT}`, "--replicas=0");
    // Health loop (15s) + dashboard poll (5s), with margin.
    await expect(card.getByText("Unreachable", { exact: true })).toBeVisible({ timeout: 45_000 });
  } finally {
    kubectl("scale", `deployment/${MCP_DEPLOYMENT}`, "--replicas=1");
  }
  kubectl("rollout", "status", `deployment/${MCP_DEPLOYMENT}`, "--timeout=120s");
  await expect(card.getByText("Connected", { exact: true })).toBeVisible({ timeout: 60_000 });
});
