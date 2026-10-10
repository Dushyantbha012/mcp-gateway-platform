import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { User } from "@/api/types";
import { renderApp } from "@/test/render";
import { admin, loggedInAs, member, server } from "@/test/server";

describe("Team page", () => {
  it("invites a member and shows the one-time link", async () => {
    loggedInAs(admin);
    const users: User[] = [admin];
    let posted: unknown;
    server.use(
      http.get("/api/users", () => HttpResponse.json(users)),
      http.post("/api/users", async ({ request }) => {
        posted = await request.json();
        const created = {
          ...member,
          email: "new@example.com",
          name: "New Person",
          hasPassword: false,
        };
        users.push(created);
        return HttpResponse.json(
          {
            ...created,
            inviteUrl: "/invite/abc",
            inviteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
          { status: 201 },
        );
      }),
    );
    const { user } = renderApp("/team");
    await user.click(await screen.findByRole("button", { name: "Invite member" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "New Person");
    await user.type(within(dialog).getByLabelText("Email"), "new@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Create invite link" }));

    const linkDialog = await screen.findByRole("dialog", { name: "New Person invited" });
    // A relative link from the gateway is made absolute for this dashboard.
    expect(within(linkDialog).getByLabelText("Invite link")).toHaveTextContent(
      `${window.location.origin}/invite/abc`,
    );
    expect(posted).toEqual({ name: "New Person", email: "new@example.com", role: "member" });
    expect(await screen.findByText("Invite pending")).toBeInTheDocument();
  });

  it("can't change your own role or disable yourself; can for others", async () => {
    loggedInAs(admin);
    let patched: unknown;
    server.use(
      http.get("/api/users", () => HttpResponse.json([admin, member])),
      http.patch("/api/users/:id", async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json({ ...member, role: "admin" });
      }),
    );
    const { user } = renderApp("/team");
    const selfRow = await screen.findByTestId(`user-${admin.email}`);
    expect(within(selfRow).getByLabelText(`Role of ${admin.email}`)).toBeDisabled();
    expect(within(selfRow).queryByRole("button", { name: "Disable" })).not.toBeInTheDocument();

    const memberRow = screen.getByTestId(`user-${member.email}`);
    await user.selectOptions(within(memberRow).getByLabelText(`Role of ${member.email}`), "admin");
    expect(patched).toEqual({ role: "admin" });
  });

  it("disables a user after confirmation", async () => {
    loggedInAs(admin);
    let patched: unknown;
    server.use(
      http.get("/api/users", () => HttpResponse.json([admin, member])),
      http.patch("/api/users/:id", async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json({ ...member, disabledAt: new Date().toISOString() });
      }),
    );
    const { user } = renderApp("/team");
    const row = await screen.findByTestId(`user-${member.email}`);
    await user.click(within(row).getByRole("button", { name: "Disable" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent(/API keys stop working immediately/);
    await user.click(within(confirm).getByRole("button", { name: "Disable" }));
    expect(patched).toEqual({ disabled: true });
  });
});
