import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { Server } from "@/api/types";
import { renderApp } from "@/test/render";
import { admin, apiError, loggedInAs, member, server, serverFixture } from "@/test/server";

describe("Servers page", () => {
  it("members see servers, status and tools, but no URLs or admin controls", async () => {
    loggedInAs(member);
    // As the gateway answers members: serverView without `url`.
    const { url: _url, ...forMember } = serverFixture();
    void _url;
    server.use(http.get("/api/servers", () => HttpResponse.json([forMember])));
    const { user } = renderApp("/servers");

    const card = await screen.findByTestId("server-woocommerce");
    expect(within(card).getByText("Connected")).toBeInTheDocument();
    expect(card).not.toHaveTextContent("http://");
    expect(within(card).queryByRole("button", { name: /Edit/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add server" })).not.toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "1 tool" }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("woocommerce__list_orders")).toBeInTheDocument();
  });

  it("shows an unreachable server with its reason", async () => {
    loggedInAs(admin);
    server.use(
      http.get("/api/servers", () =>
        HttpResponse.json([
          serverFixture({
            status: "unreachable",
            lastError: "Upstream 'woocommerce' timed out after 1500ms",
          }),
        ]),
      ),
    );
    renderApp("/servers");
    const card = await screen.findByTestId("server-woocommerce");
    expect(within(card).getByText("Unreachable")).toBeInTheDocument();
    expect(within(card).getAllByText(/timed out after 1500ms/).length).toBeGreaterThan(0);
  });

  it("picks up status changes by polling, without a reload", async () => {
    loggedInAs(admin);
    let status: Server["status"] = "connected";
    server.use(http.get("/api/servers", () => HttpResponse.json([serverFixture({ status })])));
    const { client } = renderApp("/servers");
    const card = await screen.findByTestId("server-woocommerce");
    expect(within(card).getByText("Connected")).toBeInTheDocument();
    status = "unreachable";
    // What the 5s refetchInterval does, without waiting 5s.
    await client.refetchQueries({ queryKey: ["servers"] });
    expect(await within(card).findByText("Unreachable")).toBeInTheDocument();
  });

  it("disables a server with the switch and shows the gateway's answer", async () => {
    loggedInAs(admin);
    let current = serverFixture();
    let patched: unknown;
    server.use(
      http.get("/api/servers", () => HttpResponse.json([current])),
      http.patch("/api/servers/:id", async ({ request }) => {
        patched = await request.json();
        current = { ...current, enabled: false, status: "disabled" };
        return HttpResponse.json(current);
      }),
    );
    const { user } = renderApp("/servers");
    await user.click(await screen.findByRole("switch", { name: "WooCommerce enabled" }));
    expect(patched).toEqual({ enabled: false });
    expect(await screen.findByText("Disabled")).toBeInTheDocument();
  });

  it("adds a server; the credential is sent once and the form validates first", async () => {
    loggedInAs(admin);
    const servers: Server[] = [];
    let posted: Record<string, unknown> | undefined;
    server.use(
      http.get("/api/servers", () => HttpResponse.json(servers)),
      http.post("/api/servers", async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>;
        const created = serverFixture({
          slug: "github",
          name: "GitHub",
          url: posted.url as string,
        });
        servers.push(created);
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    const { user } = renderApp("/servers");
    await user.click(await screen.findByRole("button", { name: "Add server" }));
    const dialog = await screen.findByRole("dialog");

    await user.type(within(dialog).getByLabelText("Name"), "GitHub");
    await user.type(within(dialog).getByLabelText("Slug"), "GitHub!");
    await user.type(within(dialog).getByLabelText("URL"), "https://api.githubcopilot.com/mcp/");
    await user.selectOptions(within(dialog).getByLabelText("Authentication"), "bearer");
    await user.click(within(dialog).getByRole("button", { name: "Add server" }));
    expect(await within(dialog).findByText(/lowercase letters/)).toBeInTheDocument();
    expect(within(dialog).getByText("Required for this auth type")).toBeInTheDocument();
    expect(posted).toBeUndefined();

    await user.clear(within(dialog).getByLabelText("Slug"));
    await user.type(within(dialog).getByLabelText("Slug"), "github");
    await user.type(within(dialog).getByLabelText("Bearer token"), "ghp_secret");
    await user.click(within(dialog).getByRole("button", { name: "Add server" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(posted).toEqual({
      slug: "github",
      name: "GitHub",
      url: "https://api.githubcopilot.com/mcp/",
      authType: "bearer",
      credential: "ghp_secret",
      timeoutMs: 10_000,
    });
    expect(await screen.findByTestId("server-github")).toBeInTheDocument();
  });

  it("edits without re-sending the stored credential, and shows gateway errors", async () => {
    loggedInAs(admin);
    let patched: Record<string, unknown> | undefined;
    server.use(
      http.get("/api/servers", () => HttpResponse.json([serverFixture()])),
      http.patch("/api/servers/:id", async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>;
        if (patched.slug === "taken")
          return apiError(409, "conflict", "A server with slug 'taken' already exists");
        return HttpResponse.json(serverFixture({ name: patched.name as string }));
      }),
    );
    const { user } = renderApp("/servers");
    await user.click(await screen.findByRole("button", { name: "Edit WooCommerce" }));
    const dialog = await screen.findByRole("dialog");
    const credential = within(dialog).getByLabelText("Bearer token");
    expect(credential).toHaveValue("");
    expect(credential).toHaveAttribute("placeholder", expect.stringMatching(/leave blank to keep/));

    await user.clear(within(dialog).getByLabelText("Slug"));
    await user.type(within(dialog).getByLabelText("Slug"), "taken");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already exists");
    expect(patched).not.toHaveProperty("credential");
  });

  it("asks before removing a server", async () => {
    loggedInAs(admin);
    let deleted = false;
    server.use(
      http.get("/api/servers", () => HttpResponse.json(deleted ? [] : [serverFixture()])),
      http.delete("/api/servers/:id", () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { user } = renderApp("/servers");
    const card = await screen.findByTestId("server-woocommerce");
    await user.click(within(card).getByRole("button", { name: "Remove" }));
    expect(deleted).toBe(false);
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("No MCP servers registered yet.")).toBeInTheDocument();
  });
});
