import { expect, test, type Page } from "@playwright/test";
import { adminApi, createMember, harness, login, unique } from "./fixtures.js";

async function say(page: Page, text: string) {
  await page.getByLabel("Message").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

interface AuditRow {
  userEmail: string;
  source: string;
  server: string | null;
  tool: string;
  outcome: string;
}
const chatAudit = () => adminApi<AuditRow[]>("/audit?source=chat&limit=200");

test.describe("chat agent", () => {
  test("asks, shows the tool it called, and answers from the result", async ({ page }) => {
    const { admin } = await harness();
    await login(page, admin.email, admin.password);
    await page.getByRole("link", { name: "Chat" }).click();

    await say(page, "what orders came in today?");
    const tools = page.getByRole("list", { name: "Tools called" });
    await expect(tools.getByText("alpha__list_orders")).toBeVisible();
    await expect(tools.getByText("ok", { exact: true })).toBeVisible();
    await expect(page.getByText("Tool said: list_orders:today")).toBeVisible();

    // The arguments and result are inspectable.
    await tools.getByText("alpha__list_orders").click();
    await expect(tools.getByText('"value": "today"')).toBeVisible();
  });

  test("two users: each user's chat calls land in the audit log under their own name", async ({
    page,
    browser,
  }) => {
    const { admin } = await harness();
    const member = await createMember();

    await login(page, admin.email, admin.password);
    await page.getByRole("link", { name: "Chat" }).click();
    await say(page, "orders please");
    await expect(page.getByText("Tool said: list_orders:today")).toBeVisible();

    const memberPage = await (await browser.newContext()).newPage();
    await login(memberPage, member.email, member.password);
    await memberPage.getByRole("link", { name: "Chat" }).click();
    await say(memberPage, "orders please");
    await expect(memberPage.getByText("Tool said: list_orders:today")).toBeVisible();

    const rows = await chatAudit();
    const mine = (email: string) => rows.filter((r) => r.userEmail === email);
    expect(mine(admin.email)[0]).toMatchObject({
      source: "chat",
      server: "alpha",
      tool: "alpha__list_orders",
      outcome: "success",
    });
    expect(mine(member.email)[0]).toMatchObject({
      source: "chat",
      tool: "alpha__list_orders",
      outcome: "success",
    });

    // ...and the admin sees both in the dashboard's audit page.
    await page.getByRole("link", { name: "Audit log" }).click();
    await expect(
      page.getByRole("row").filter({ hasText: member.email }).filter({ hasText: "chat" }).first(),
    ).toContainText("alpha__list_orders");
  });

  test("a tool error is shown as failed and the agent still answers", async ({ page }) => {
    const { admin } = await harness();
    await login(page, admin.email, admin.password);
    await page.getByRole("link", { name: "Chat" }).click();
    await say(page, "find the missing order");
    await expect(page.getByText("failed", { exact: true })).toBeVisible();
    await expect(page.getByText("Tool said: Order 999 not found")).toBeVisible();
  });

  test("disabling a server takes its tools away from chat on the next message", async ({
    page,
  }) => {
    const { admin } = await harness();
    const servers = await adminApi<{ id: string; slug: string }[]>("/servers");
    const alpha = servers.find((s) => s.slug === "alpha")!;
    await login(page, admin.email, admin.password);
    await page.getByRole("link", { name: "Chat" }).click();

    await adminApi(`/servers/${alpha.id}`, { method: "PATCH", body: { enabled: false } });
    try {
      await say(page, "orders again");
      await expect(page.getByText("failed", { exact: true })).toBeVisible();
      await expect(page.getByText("Tool said: Server 'alpha' is disabled")).toBeVisible();
      expect((await chatAudit())[0]).toMatchObject({ server: "alpha", outcome: "rejected" });
    } finally {
      await adminApi(`/servers/${alpha.id}`, { method: "PATCH", body: { enabled: true } });
    }
  });

  test("Stop ends a turn that never finishes", async ({ page }) => {
    const { admin } = await harness();
    await login(page, admin.email, admin.password);
    await page.getByRole("link", { name: "Chat" }).click();
    await say(page, `slow question ${unique()}`);
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByText("Stopped.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled(); // empty input
    await page.getByLabel("Message").fill("hello");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  });
});
