import { expect, test } from "@playwright/test";
import { harness, login } from "./fixtures.js";

test("wrong password is refused; logging out ends the session", async ({ page }) => {
  const { admin } = await harness();
  await page.goto("/servers");
  await expect(page).toHaveURL(/\/login\?next=%2Fservers/);

  await page.getByLabel("Email").fill(admin.email);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("alert")).toContainText("Invalid email or password");

  await login(page, admin.email, admin.password);
  // The session cookie is HttpOnly and scoped to /api: page scripts can't read it.
  expect(await page.evaluate(() => document.cookie)).not.toContain("mgw_session");
  const [cookie] = (await page.context().cookies()).filter((c) => c.name === "mgw_session");
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/api" });

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
  await page.goto("/servers");
  await expect(page).toHaveURL(/\/login/);
});

test("a page on another origin can't use the session to change anything (CSRF)", async ({
  page,
  request,
}) => {
  const { admin, gatewayUrl } = await harness();
  await login(page, admin.email, admin.password);
  const [cookie] = (await page.context().cookies()).filter((c) => c.name === "mgw_session");
  // Replays the cookie with a foreign Origin, as a cross-site form post would.
  const res = await request.post(`${gatewayUrl}/api/users/me/keys`, {
    headers: { Cookie: `mgw_session=${cookie.value}`, Origin: "http://evil.test" },
    data: { name: "csrf" },
  });
  expect(res.status()).toBe(403);
});
