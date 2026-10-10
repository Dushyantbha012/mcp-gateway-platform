import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/urls";
import { renderApp } from "@/test/render";
import { admin, apiError, loggedInAs, member, server, serverFixture } from "@/test/server";

const location = () => screen.getByTestId("location").textContent;

describe("auth routing", () => {
  it("sends a logged-out visitor to /login, remembering where they were going", async () => {
    server.use(http.get("/api/me", () => apiError(401, "unauthorized", "Not logged in")));
    renderApp("/audit?x=1");
    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
    expect(location()).toBe(`/login?next=${encodeURIComponent("/audit?x=1")}`);
  });

  it("logs in and continues to the remembered page", async () => {
    let loggedIn = false;
    server.use(
      http.get("/api/me", () =>
        loggedIn ? HttpResponse.json(admin) : apiError(401, "unauthorized", "x"),
      ),
      http.post("/api/auth/login", async ({ request }) => {
        const body = (await request.json()) as { email: string; password: string };
        if (body.password !== "right-password") {
          return apiError(401, "invalid_credentials", "Invalid email or password");
        }
        loggedIn = true;
        return HttpResponse.json(admin);
      }),
      http.get("/api/tools", () => HttpResponse.json([])),
      http.get("/api/meta", () => HttpResponse.json({ mcpUrl: null })),
    );
    const { user } = renderApp("/tools");
    await screen.findByRole("heading", { name: "Log in" });

    await user.type(screen.getByLabelText("Email"), "admin@example.com");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");

    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "right-password");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("heading", { name: "Tools" })).toBeInTheDocument();
    expect(location()).toBe("/tools");
  });

  it("validates the login form before calling the gateway", async () => {
    server.use(http.get("/api/me", () => apiError(401, "unauthorized", "x")));
    const { user } = renderApp("/login");
    await user.click(await screen.findByRole("button", { name: "Log in" }));
    expect(await screen.findByText("Enter a valid email")).toBeInTheDocument();
    expect(screen.getByText("Enter your password")).toBeInTheDocument();
  });

  it("shows the gateway's rate-limit message", async () => {
    server.use(
      http.get("/api/me", () => apiError(401, "unauthorized", "x")),
      http.post("/api/auth/login", () =>
        apiError(429, "too_many_attempts", "Too many failed logins, try again later"),
      ),
    );
    const { user } = renderApp("/login");
    await user.type(await screen.findByLabelText("Email"), "a@b.co");
    await user.type(screen.getByLabelText("Password"), "whatever");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many failed logins");
  });

  it("returns to the login page when the session dies mid-use (any 401)", async () => {
    let alive = true;
    server.use(
      http.get("/api/me", () =>
        alive ? HttpResponse.json(admin) : apiError(401, "unauthorized", "x"),
      ),
      http.get("/api/servers", () =>
        alive
          ? HttpResponse.json([serverFixture()])
          : apiError(401, "unauthorized", "Session expired"),
      ),
    );
    const { client } = renderApp("/servers");
    expect(await screen.findByRole("heading", { name: "WooCommerce" })).toBeInTheDocument();
    alive = false; // e.g. an admin disabled this user
    await client.refetchQueries({ queryKey: ["servers"] });
    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
  });

  it.each([
    [null, "/servers"],
    ["/audit", "/audit"],
    ["/keys?x=1", "/keys?x=1"],
    ["https://evil.test", "/servers"],
    ["//evil.test/x", "/servers"],
    ["/\\evil.test", "/servers"],
    ["/\\/evil.test", "/servers"],
    ["javascript:alert(1)", "/servers"],
  ])("safeNext(%j) -> %j (no open redirect)", (next, expected) => {
    expect(safeNext(next)).toBe(expected);
  });
});

describe("role-based navigation", () => {
  it("members don't see Team or Audit, and are bounced from those URLs", async () => {
    loggedInAs(member);
    server.use(http.get("/api/servers", () => HttpResponse.json([])));
    renderApp("/team");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Chat", "Servers", "Tools", "API keys"]);
    await waitFor(() => expect(location()).toBe("/servers"));
  });

  it("admins see every page", async () => {
    loggedInAs(admin);
    server.use(http.get("/api/servers", () => HttpResponse.json([])));
    renderApp("/servers");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Chat", "Servers", "Tools", "API keys", "Team", "Audit log"]);
  });

  it("logs out from the account menu", async () => {
    loggedInAs(admin);
    let loggedOut = false;
    server.use(
      http.get("/api/servers", () => HttpResponse.json([])),
      http.post("/api/auth/logout", () => {
        loggedOut = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { user } = renderApp("/servers");
    await user.click(await screen.findByRole("button", { name: "Account menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Log out" }));
    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
    expect(loggedOut).toBe(true);
  });
});
