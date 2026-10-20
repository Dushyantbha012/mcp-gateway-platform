import { expect, test } from "@playwright/test";
import { harness, login, unique } from "./fixtures.js";

// The harness runs no provisioner, so this covers the dashboard <-> API half:
// the request is recorded, shown as provisioning, and can be withdrawn.
test("a user creates a store, sees it queued, and deletes it", async ({ page }) => {
  const { admin } = await harness();
  await login(page, admin.email, admin.password);
  await page.getByRole("link", { name: "Stores" }).click();
  await expect(page.getByRole("heading", { name: "Stores", level: 1 })).toBeVisible();

  const name = `Shop ${unique()}`;
  const slug = name.toLowerCase().replace(" ", "-");
  await page.getByRole("button", { name: "Create store" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Store name").fill(name);
  await dialog.getByRole("button", { name: "Create store" }).click();
  await expect(dialog).toBeHidden();

  const row = page.getByTestId(`store-${slug}`);
  await expect(row.getByText("Provisioning")).toBeVisible();
  await expect(row.getByText("Queued")).toBeVisible();
  await expect(row).toContainText(admin.email);

  await row.getByRole("button", { name: `Delete ${name}` }).click();
  await page.getByRole("button", { name: "Delete store" }).click();
  await expect(row.getByText("Deleting")).toBeVisible();
  // Nothing left to click while the provisioner tears it down.
  await expect(row.getByRole("button", { name: `Delete ${name}` })).toHaveCount(0);
});
