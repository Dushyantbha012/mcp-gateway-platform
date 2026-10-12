import { expect, test } from "@playwright/test";
import { fakeAuthHeaders, harness, login, setFakeBehavior, toolNames, unique } from "./fixtures.js";

test.describe("admin manages MCP servers", () => {
  test("the pre-registered server is listed as Connected with its tools", async ({ page }) => {
    const { admin } = await harness();
    await login(page, admin.email, admin.password);
    const card = page.getByTestId("server-alpha");
    await expect(card.getByText("Connected", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: /tools/ }).click();
    await expect(card.getByText("alpha__list_orders")).toBeVisible();
  });

  test("refuses a server URL that points at an internal address (SSRF guard)", async ({ page }) => {
    const { admin } = await harness();
    await login(page, admin.email, admin.password);
    await page.getByRole("button", { name: "Add server" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("Metadata");
    await dialog.getByLabel("Slug").fill(`meta-${unique()}`);
    await dialog.getByLabel("URL").fill("http://169.254.169.254/latest/meta-data/");
    await dialog.getByRole("button", { name: "Add server" }).click();
    await expect(dialog).toContainText("not allowed");
    await expect(dialog).toContainText("link-local");
    // Still open, nothing was added.
    await expect(dialog).toBeVisible();
  });

  test("add (with a credential) -> disable -> enable -> unreachable -> remove, reflected at once for MCP clients", async ({
    page,
  }) => {
    const { admin, fakes } = await harness();
    const slug = `beta-${unique()}`;
    const credential = `beta-secret-${unique()}`;
    // Every API response body the browser receives, to prove the credential never comes back.
    const bodies: string[] = [];
    page.on("response", async (res) => {
      if (res.url().includes("/api/")) bodies.push(await res.text().catch(() => ""));
    });

    await login(page, admin.email, admin.password);
    await page.getByRole("button", { name: "Add server" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("Beta Docs");
    await dialog.getByLabel("Slug").fill(slug);
    await dialog.getByLabel("URL").fill(fakes.beta);
    await dialog.getByLabel("Authentication").selectOption("bearer");
    await dialog.getByLabel("Bearer token").fill(credential);
    await dialog.getByRole("button", { name: "Add server" }).click();

    const card = page.getByTestId(`server-${slug}`);
    await expect(card.getByText("Connected", { exact: true })).toBeVisible();
    await expect(card).toContainText("credential stored");
    // The gateway, not the browser, sent the credential upstream.
    expect(await fakeAuthHeaders("beta")).toContain(`Bearer ${credential}`);
    expect(await toolNames(admin.apiKey)).toContain(`${slug}__search_docs`);

    // Disable: tools disappear for MCP clients on their next list.
    await card.getByRole("switch", { name: "Beta Docs enabled" }).click();
    await expect(card.getByText("Disabled", { exact: true })).toBeVisible();
    expect(await toolNames(admin.apiKey)).not.toContain(`${slug}__search_docs`);

    await card.getByRole("switch", { name: "Beta Docs enabled" }).click();
    await expect(card.getByText("Connected", { exact: true })).toBeVisible();
    expect(await toolNames(admin.apiKey)).toContain(`${slug}__search_docs`);

    // A dead upstream shows as Unreachable with a reason, and its tools are hidden.
    await setFakeBehavior("beta", "http500");
    try {
      await card.getByRole("button", { name: "Check Beta Docs now" }).click();
      await expect(card.getByText("Unreachable", { exact: true })).toBeVisible();
      await expect(card).toContainText("returned HTTP 500");
      const names = await toolNames(admin.apiKey);
      expect(names).not.toContain(`${slug}__search_docs`);
      expect(names).toContain("alpha__list_orders"); // the other server is unaffected
    } finally {
      await setFakeBehavior("beta", "ok");
    }
    // The health loop brings it back by itself.
    await expect(card.getByText("Connected", { exact: true })).toBeVisible({ timeout: 15_000 });

    await card.getByRole("button", { name: "Remove" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(card).toHaveCount(0);
    expect(await toolNames(admin.apiKey)).not.toContain(`${slug}__search_docs`);

    expect(bodies.length).toBeGreaterThan(5);
    for (const body of bodies) expect(body).not.toContain(credential);
  });
});
