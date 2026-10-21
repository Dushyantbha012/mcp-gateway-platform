import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectedApp, OAuthRequest } from "@/api/types";
import { browserNav } from "@/lib/urls";
import { renderApp } from "@/test/render";
import { apiError, loggedInAs, member, server } from "@/test/server";

const REQ = "55555555-5555-5555-5555-555555555555";

const request = (overrides: Partial<OAuthRequest> = {}): OAuthRequest => ({
  id: REQ,
  clientId: "mgc_abcdefghijklmnopqrstuv",
  clientName: "Claude Code",
  redirectUri: "http://127.0.0.1:33418/callback",
  redirectHost: "127.0.0.1:33418",
  scopes: ["mcp:read", "mcp:write"],
  resource: "http://gateway.test/mcp",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  ...overrides,
});

/** Stubs the consent API; returns the decisions it received. */
function consentApi(req: OAuthRequest = request()) {
  const decisions: unknown[] = [];
  server.use(
    http.get(`/api/oauth/requests/${REQ}`, () => HttpResponse.json(req)),
    http.post(`/api/oauth/requests/${REQ}`, async ({ request: r }) => {
      const body = (await r.json()) as { approve: boolean };
      decisions.push(body);
      return HttpResponse.json({
        redirectUrl: body.approve
          ? "http://127.0.0.1:33418/callback?code=abc&state=s"
          : "http://127.0.0.1:33418/callback?error=access_denied&state=s",
      });
    }),
  );
  return decisions;
}

describe("OAuth consent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a logged-out user to log in first, then back here", async () => {
    server.use(
      http.get("/api/me", () => apiError(401, "unauthorized", "Not logged in")),
      http.get("/api/meta", () => HttpResponse.json({ mcpUrl: null, chatEnabled: false })),
    );
    renderApp(`/oauth/consent?req=${REQ}`);
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        `/login?next=${encodeURIComponent(`/oauth/consent?req=${REQ}`)}`,
      ),
    );
  });

  it("shows who is asking, and approving sends the browser back with the code", async () => {
    loggedInAs(member);
    const decisions = consentApi();
    const assign = vi.spyOn(browserNav, "assign").mockImplementation(() => {});
    const { user } = renderApp(`/oauth/consent?req=${REQ}`);

    expect(await screen.findByRole("heading", { name: "Connect Claude Code?" })).toBeVisible();
    expect(screen.getByText(member.email)).toBeInTheDocument();
    expect(screen.getByText("127.0.0.1:33418")).toBeInTheDocument();
    expect(screen.getByText(/an app on this computer/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Read" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Change data" })).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("http://127.0.0.1:33418/callback?code=abc&state=s"),
    );
    expect(decisions).toEqual([{ approve: true, scopes: ["mcp:read", "mcp:write"] }]);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("can grant read only; turning read off turns write off and disables Approve", async () => {
    loggedInAs(member);
    const decisions = consentApi();
    vi.spyOn(browserNav, "assign").mockImplementation(() => {});
    const { user } = renderApp(`/oauth/consent?req=${REQ}`);
    const write = await screen.findByRole("switch", { name: "Change data" });
    const read = screen.getByRole("switch", { name: "Read" });

    await user.click(read);
    expect(read).not.toBeChecked();
    expect(write).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();

    await user.click(write); // write brings read back
    expect(read).toBeChecked();
    await user.click(write);
    expect(write).not.toBeChecked();
    expect(read).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(decisions).toEqual([{ approve: true, scopes: ["mcp:read"] }]));
  });

  it("offers only what the app asked for", async () => {
    loggedInAs(member);
    consentApi(request({ scopes: ["mcp:read"], redirectHost: "claude.ai" }));
    renderApp(`/oauth/consent?req=${REQ}`);
    await screen.findByRole("switch", { name: "Read" });
    expect(screen.queryByRole("switch", { name: "Change data" })).not.toBeInTheDocument();
    expect(screen.queryByText(/an app on this computer/)).not.toBeInTheDocument();
  });

  it("deny sends the browser back with access_denied", async () => {
    loggedInAs(member);
    const decisions = consentApi();
    const assign = vi.spyOn(browserNav, "assign").mockImplementation(() => {});
    const { user } = renderApp(`/oauth/consent?req=${REQ}`);
    await user.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        "http://127.0.0.1:33418/callback?error=access_denied&state=s",
      ),
    );
    expect(decisions).toEqual([{ approve: false }]);
  });

  it("says so when the request expired or was used", async () => {
    loggedInAs(member);
    server.use(
      http.get(`/api/oauth/requests/${REQ}`, () =>
        apiError(404, "not_found", "Authorization request not found"),
      ),
    );
    renderApp(`/oauth/consent?req=${REQ}`);
    expect(await screen.findByText(/expired or was already used/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });
});

describe("Connected apps", () => {
  const app: ConnectedApp = {
    id: "66666666-6666-6666-6666-666666666666",
    clientId: "mgc_abcdefghijklmnopqrstuv",
    clientName: "Claude Code",
    scopes: ["mcp:read"],
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };

  it("is hidden when OAuth is off", async () => {
    loggedInAs(member);
    server.use(http.get("/api/users/me/keys", () => HttpResponse.json([])));
    renderApp("/keys");
    await screen.findByText("No API keys yet.");
    expect(screen.queryByRole("heading", { name: "Connected apps" })).not.toBeInTheDocument();
  });

  it("lists apps and disconnects one after confirmation", async () => {
    loggedInAs(member);
    let apps = [app];
    const revoked: string[] = [];
    server.use(
      http.get("/api/meta", () =>
        HttpResponse.json({
          mcpUrl: "http://gateway.test/mcp",
          chatEnabled: false,
          oauthEnabled: true,
        }),
      ),
      http.get("/api/users/me/keys", () => HttpResponse.json([])),
      http.get("/api/oauth/apps", () => HttpResponse.json(apps)),
      http.delete("/api/oauth/apps/:id", ({ params }) => {
        revoked.push(params.id as string);
        apps = [];
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { user } = renderApp("/keys");
    const section = (await screen.findByRole("heading", { name: "Connected apps" })).closest(
      "section",
    )!;
    expect(
      within(section).getByText(
        /claude mcp add --transport http gateway http:\/\/gateway.test\/mcp/,
      ),
    ).toBeInTheDocument();
    const row = (await within(section).findByText("Claude Code")).closest("tr")!;
    expect(within(row).getByText("Read only")).toBeInTheDocument();

    await user.click(within(row).getByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(await within(section).findByText("No connected apps.")).toBeInTheDocument();
    expect(revoked).toEqual([app.id]);
  });
});
