import { expect, test } from "@playwright/test";
import { harness, login, mcpClient, unique } from "./fixtures.js";

test("two users: admin invites a member, the member connects an MCP client, the admin audits, revokes and disables", async ({
  page,
  browser,
}) => {
  const { admin } = await harness();
  const email = `member-${unique()}@e2e.test`;
  const password = "member-password-123";

  // --- Admin: invite ---
  await login(page, admin.email, admin.password);
  await page.getByRole("link", { name: "Team" }).click();
  await page.getByRole("button", { name: "Invite member" }).click();
  const invite = page.getByRole("dialog");
  await invite.getByLabel("Name").fill("Bea Member");
  await invite.getByLabel("Email").fill(email);
  await invite.getByRole("button", { name: "Create invite link" }).click();
  const inviteUrl = (await page.getByLabel("Invite link", { exact: true }).textContent())!;
  expect(inviteUrl).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId(`user-${email}`)).toContainText("Invite pending");

  // --- Member, in a separate browser context (own cookies): accept and set a password ---
  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await memberPage.goto(inviteUrl);
  await expect(memberPage.getByRole("heading", { name: "Welcome, Bea Member" })).toBeVisible();
  await memberPage.getByLabel("New password").fill(password);
  await memberPage.getByLabel("Confirm password").fill(password);
  await memberPage.getByRole("button", { name: /Set password/ }).click();
  await expect(memberPage.getByRole("heading", { name: "MCP servers" })).toBeVisible();

  // A member's view: no admin pages, no edit controls, no upstream URLs.
  const nav = memberPage.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link")).toHaveText(["Chat", "Servers", "Tools", "API keys"]);
  await expect(memberPage.getByRole("button", { name: "Add server" })).toHaveCount(0);
  await expect(memberPage.getByTestId("server-alpha").getByRole("switch")).toHaveCount(0);
  await expect(memberPage.getByTestId("server-alpha")).not.toContainText("http://");
  await memberPage.goto("/audit");
  await expect(memberPage).toHaveURL(/\/servers$/);

  // The member generates their own key; it's shown once.
  await memberPage.getByRole("link", { name: "API keys" }).click();
  await memberPage.getByLabel("Key name").fill("laptop");
  await memberPage.getByRole("button", { name: "Create API key" }).click();
  const key = (await memberPage.getByLabel("New API key", { exact: true }).textContent())!;
  expect(key).toMatch(/^mgw_[0-9a-f]{8}_/);
  await memberPage.getByRole("button", { name: "I've copied it" }).click();
  await expect(memberPage.getByText(key)).toHaveCount(0);

  // --- External MCP client as the member: gateway URL + key only ---
  const client = await mcpClient(key);
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toContain("alpha__list_orders");
  const result = await client.callTool({
    name: "alpha__list_orders",
    arguments: { value: "today" },
  });
  expect(result.isError).toBeFalsy();
  await client.close();

  // --- Admin: the call is in the audit log under the member ---
  await page.getByRole("link", { name: "Audit log" }).click();
  const row = page.getByTestId("audit-row").filter({ hasText: email }).first();
  await expect(row).toContainText("alpha__list_orders");
  await expect(row).toContainText("Success");
  await expect(row).toContainText("MCP");

  // --- Admin revokes the member's key: the next call is rejected ---
  await page.getByRole("link", { name: "Team" }).click();
  await page.getByRole("button", { name: `API keys of ${email}` }).click();
  await page.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText(/^Revoked/)).toBeVisible();
  await expect(mcpClient(key)).rejects.toThrow(/401|invalid or revoked/i);

  // --- Admin disables the member: their open dashboard session ends ---
  await memberPage.getByRole("link", { name: "Servers" }).click();
  const memberRow = page.getByTestId(`user-${email}`);
  await memberRow.getByRole("button", { name: "Disable" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Disable" }).click();
  await expect(memberRow).toContainText("Disabled");
  // The member's page polls every 5s; its next request gets a 401.
  await expect(memberPage.getByRole("heading", { name: "Log in" })).toBeVisible({
    timeout: 15_000,
  });
  await memberContext.close();
});
