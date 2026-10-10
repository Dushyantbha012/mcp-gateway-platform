import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * The brief's Store step, automated against the live storefront: add a
 * product to the cart, check out with Cash on Delivery, then find the order
 * in WooCommerce admin.
 *
 *   STORE_URL=http://store.local.test STORE_ADMIN_USER=... STORE_ADMIN_PASSWORD=... \
 *   STOREFRONT_PRODUCT=/product/urumi-coffee-mug/ npm run test:live -w e2e
 *
 * STOREFRONT_PRODUCT is a product path (default: a seeded demo product).
 * When ORDER_OUT is set, the order number is written there as JSON for the
 * system suite, which then asks the chat agent about this exact order.
 */
const store = process.env.STORE_URL ?? "http://store.local.test";
const product = process.env.STOREFRONT_PRODUCT ?? "/product/urumi-coffee-mug/";
const adminUser = process.env.STORE_ADMIN_USER;
const adminPassword = process.env.STORE_ADMIN_PASSWORD;

test.skip(!adminUser || !adminPassword, "set STORE_ADMIN_USER and STORE_ADMIN_PASSWORD");

async function fillIfPresent(page: Page, label: RegExp, value: string) {
  const field = page.getByLabel(label).first();
  if (await field.isVisible().catch(() => false)) await field.fill(value);
}

test("live: storefront COD checkout, then the order is in WooCommerce admin", async ({ page }) => {
  await page.goto(`${store}${product}`);
  await page.locator("button.single_add_to_cart_button").click();
  await page.goto(`${store}/checkout/`);

  await page.getByLabel("Email address").fill("shopper@example.com");
  await fillIfPresent(page, /^First name/, "Test");
  await fillIfPresent(page, /^Last name/, "Shopper");
  await fillIfPresent(page, /^Address/, "1 Test Street");
  await fillIfPresent(page, /^City/, "Testville");
  // The store's default country is the US, so use a valid US state and ZIP.
  await page.getByLabel("State").selectOption({ label: "California" });
  await fillIfPresent(page, /^(Postcode|ZIP)/, "94103");
  await fillIfPresent(page, /^Phone/, "5555550100");

  await page.getByRole("radio", { name: /cash on delivery/i }).check();
  await page.getByRole("button", { name: /place order/i }).click();

  await page.waitForURL(/order-received/);
  const orderId = (await page.url().match(/order-received\/(\d+)/))?.[1];
  expect(orderId, "order id in the confirmation URL").toBeTruthy();
  await expect(page.getByText(/order has been received|thank you/i).first()).toBeVisible();
  if (process.env.ORDER_OUT) {
    writeFileSync(process.env.ORDER_OUT, JSON.stringify({ orderId: Number(orderId) }));
  }

  await page.goto(`${store}/wp-login.php`);
  await page.getByLabel("Username or Email Address").fill(adminUser!);
  await page.getByLabel("Password", { exact: true }).fill(adminPassword!);
  await page.getByRole("button", { name: "Log In" }).click();
  await page.goto(`${store}/wp-admin/admin.php?page=wc-orders&action=edit&id=${orderId}`);
  await expect(page.getByRole("heading", { name: new RegExp(`Order #${orderId}`) })).toBeVisible();
  await expect(page.locator("body")).toContainText(/cash on delivery/i);
});
