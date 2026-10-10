import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { ApiKey } from "@/api/types";
import { renderApp } from "@/test/render";
import { loggedInAs, member, server } from "@/test/server";

const KEY = "mgw_1a2b3c4d_" + "x".repeat(43);

describe("API keys", () => {
  it("shows a new key exactly once, with a ready-made client command", async () => {
    loggedInAs(member);
    const keys: ApiKey[] = [];
    server.use(
      http.get("/api/users/me/keys", () => HttpResponse.json(keys)),
      http.post("/api/users/me/keys", async ({ request }) => {
        const { name } = (await request.json()) as { name: string };
        const info: ApiKey = {
          id: "k1",
          userId: member.id,
          name,
          prefix: "mgw_1a2b3c4d",
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          revokedAt: null,
        };
        keys.push(info);
        return HttpResponse.json({ ...info, key: KEY }, { status: 201 });
      }),
    );
    const { user } = renderApp("/keys");
    await screen.findByText("No API keys yet.");
    await user.click(screen.getByRole("button", { name: "Create API key" }));
    expect(await screen.findByText("Give the key a name")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Key name"), "laptop");
    await user.click(screen.getByRole("button", { name: "Create API key" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("New API key")).toHaveTextContent(KEY);
    expect(within(dialog).getByLabelText("Claude Code command")).toHaveTextContent(
      `claude mcp add --transport http gateway http://gateway.test/mcp --header "Authorization: Bearer ${KEY}"`,
    );

    await user.click(within(dialog).getByRole("button", { name: "I've copied it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // Only the prefix is ever shown again.
    expect(document.body).not.toHaveTextContent(KEY);
    expect(screen.getByText("mgw_1a2b3c4d…")).toBeInTheDocument();
  });

  it("revokes a key after confirmation", async () => {
    loggedInAs(member);
    let key: ApiKey = {
      id: "k1",
      userId: member.id,
      name: "laptop",
      prefix: "mgw_1a2b3c4d",
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      revokedAt: null,
    };
    server.use(
      http.get("/api/users/me/keys", () => HttpResponse.json([key])),
      http.delete("/api/keys/k1", () => {
        key = { ...key, revokedAt: new Date().toISOString() };
        return HttpResponse.json(key);
      }),
    );
    const { user } = renderApp("/keys");
    expect(await screen.findByText("Active")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revoke" }),
    );
    expect(await screen.findByText(/^Revoked/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke" })).not.toBeInTheDocument();
  });
});
