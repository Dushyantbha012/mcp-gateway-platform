import { expect, test, type Page } from "@playwright/test";
import {
  adminApi,
  createMember,
  harness,
  login,
  mcpClient,
  toolNames as allToolNames,
  unique,
} from "./fixtures.js";

// The fake upstreams always add `fail` and `big` helper tools; they are not under test.
const toolNames = async (key: string) =>
  (await allToolNames(key)).filter((n) => !/__(fail|big)$/.test(n));

interface Rule {
  id: string;
}

/** A member with a ready API key, created through the API so the test can focus on permissions. */
async function memberWithKey() {
  const { email, password } = await createMember();
  const users = await adminApi<{ id: string; email: string }[]>("/users");
  const id = users.find((u) => u.email === email)!.id;
  const { key } = await adminApi<{ key: string }>(`/users/${id}/keys`, {
    method: "POST",
    body: { name: `e2e-${unique()}` },
  });
  return { id, email, password, key };
}

async function clearRules() {
  for (const rule of await adminApi<Rule[]>("/permissions")) {
    await adminApi(`/permissions/${rule.id}`, { method: "DELETE" });
  }
}

const ruleFor = (page: Page, subject: string, tool: string) =>
  page.getByLabel(`Rule for ${subject} on ${tool}`, { exact: true });

test.beforeEach(clearRules);
test.afterEach(clearRules);

test("admin hides a tool from all members in the UI: gone from their tools/list, refused if called, audited as denied", async ({
  page,
  browser,
}) => {
  const { admin } = await harness();
  const bea = await memberWithKey();

  // Before: the member sees both of alpha's tools.
  expect(await toolNames(bea.key)).toEqual(["alpha__get_order", "alpha__list_orders"]);

  // --- Admin denies alpha's get_order for all members ---
  await login(page, admin.email, admin.password);
  await page.getByRole("link", { name: "Permissions" }).click();
  await expect(page.getByRole("heading", { name: "Permissions", level: 1 })).toBeVisible();
  const alpha = page.getByRole("heading", { name: "Alpha Shop" });
  await expect(alpha).toBeVisible();
  await ruleFor(page, "all members", "get_order").selectOption("deny");
  await expect(page.getByText("Permissions updated")).toBeVisible();
  const row = ruleFor(page, "all members", "get_order").locator("xpath=ancestor::tr");
  await expect(row).toContainText("Hidden");
  await expect(row).toContainText("role tool rule");
  await expect(
    ruleFor(page, "all members", "list_orders").locator("xpath=ancestor::tr"),
  ).toContainText("Allowed");

  // --- The member's external client: hidden from the list, refused when called directly ---
  expect(await toolNames(bea.key)).toEqual(["alpha__list_orders"]);
  const client = await mcpClient(bea.key);
  const refused = await client.callTool({ name: "alpha__get_order", arguments: {} });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused.content)).toContain("don't have permission");
  const allowed = await client.callTool({ name: "alpha__list_orders", arguments: { value: "x" } });
  expect(allowed.isError).toBeFalsy();
  await client.close();

  // Admins are unaffected.
  expect(await toolNames(admin.apiKey)).toEqual(["alpha__get_order", "alpha__list_orders"]);

  // --- The member's own dashboard no longer lists it, and can't open the page ---
  const ctx = await browser.newContext();
  const memberPage = await ctx.newPage();
  await login(memberPage, bea.email, bea.password);
  await memberPage.getByRole("link", { name: "Tools" }).click();
  await expect(memberPage.getByText("alpha__list_orders")).toBeVisible();
  await expect(memberPage.getByText("alpha__get_order")).toHaveCount(0);
  await memberPage.goto("/permissions");
  await expect(memberPage).toHaveURL(/localhost:\d+\/$/); // non-admin pages send a member to the Overview
  await ctx.close();

  // --- The denied attempt is in the audit log under the member ---
  await page.getByRole("link", { name: "Audit log" }).click();
  const auditRow = page
    .getByTestId("audit-row")
    .filter({ hasText: bea.email })
    .filter({ hasText: "alpha__get_order" })
    .first();
  await expect(auditRow).toContainText("Denied");
  await expect(auditRow).toContainText("MCP");

  // --- Back to Inherit: the tool returns on the member's very next list ---
  await page.getByRole("link", { name: "Permissions" }).click();
  await ruleFor(page, "all members", "get_order").selectOption("inherit");
  await expect(page.getByText("Permissions updated")).toBeVisible();
  await expect.poll(() => toolNames(bea.key)).toEqual(["alpha__get_order", "alpha__list_orders"]);
});

test("a personal allow overrides a role-wide server deny for that person only", async ({
  page,
}) => {
  const { admin } = await harness();
  const bea = await memberWithKey();
  const cal = await memberWithKey();

  await login(page, admin.email, admin.password);
  await page.getByRole("link", { name: "Permissions" }).click();
  await ruleFor(page, "all members", "Whole server").selectOption("deny");
  await expect(page.getByText("Permissions updated")).toBeVisible();
  expect(await toolNames(bea.key)).toEqual([]);
  expect(await toolNames(cal.key)).toEqual([]);

  // Switch to Bea alone and allow the whole server for her.
  await expect(page.getByRole("option", { name: new RegExp(bea.email) })).toBeAttached();
  await page.getByLabel("Applies to").selectOption(`user:${bea.id}`);
  await ruleFor(page, bea.email, "Whole server").selectOption("allow");
  await expect(page.getByText("Permissions updated").last()).toBeVisible();

  await expect.poll(() => toolNames(bea.key)).toEqual(["alpha__get_order", "alpha__list_orders"]);
  expect(await toolNames(cal.key)).toEqual([]);
  expect(await toolNames(admin.apiKey)).toEqual(["alpha__get_order", "alpha__list_orders"]);
});
