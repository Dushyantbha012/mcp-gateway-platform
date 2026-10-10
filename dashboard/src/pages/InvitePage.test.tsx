import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render";
import { apiError, member, server } from "@/test/server";

const TOKEN = "t".repeat(43);

describe("Invite page", () => {
  it("explains an invalid or used link", async () => {
    server.use(
      http.get("/api/me", () => apiError(401, "unauthorized", "x")),
      http.get(`/api/auth/invites/${TOKEN}`, () => apiError(404, "invalid_invite", "nope")),
    );
    renderApp(`/invite/${TOKEN}`);
    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid, already used, or expired/);
  });

  it("checks the password locally, then sets it and lands logged in", async () => {
    let accepted: unknown;
    let loggedIn = false;
    server.use(
      http.get("/api/me", () =>
        loggedIn ? HttpResponse.json(member) : apiError(401, "unauthorized", "x"),
      ),
      http.get(`/api/auth/invites/${TOKEN}`, () =>
        HttpResponse.json({ email: member.email, name: "Max", isReset: false }),
      ),
      http.post(`/api/auth/invites/${TOKEN}/accept`, async ({ request }) => {
        accepted = await request.json();
        loggedIn = true;
        return HttpResponse.json(member);
      }),
      http.get("/api/servers", () => HttpResponse.json([])),
    );
    const { user } = renderApp(`/invite/${TOKEN}`);
    expect(await screen.findByRole("heading", { name: "Welcome, Max" })).toBeInTheDocument();
    expect(screen.getByText(member.email)).toBeInTheDocument();

    await user.type(screen.getByLabelText("New password"), "short");
    await user.type(screen.getByLabelText("Confirm password"), "different");
    await user.click(screen.getByRole("button", { name: /Set password/ }));
    expect(await screen.findByText("At least 12 characters")).toBeInTheDocument();
    expect(screen.getByText("Passwords don't match")).toBeInTheDocument();
    expect(accepted).toBeUndefined();

    await user.clear(screen.getByLabelText("New password"));
    await user.clear(screen.getByLabelText("Confirm password"));
    await user.type(screen.getByLabelText("New password"), "a-long-enough-password");
    await user.type(screen.getByLabelText("Confirm password"), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: /Set password/ }));
    expect(await screen.findByRole("heading", { name: "MCP servers" })).toBeInTheDocument();
    expect(accepted).toEqual({ password: "a-long-enough-password" });
  });

  it("says when the link is a password reset", async () => {
    server.use(
      http.get("/api/me", () => apiError(401, "unauthorized", "x")),
      http.get(`/api/auth/invites/${TOKEN}`, () =>
        HttpResponse.json({ email: member.email, name: "Max", isReset: true }),
      ),
    );
    renderApp(`/invite/${TOKEN}`);
    expect(await screen.findByRole("heading", { name: "Reset your password" })).toBeInTheDocument();
  });
});
