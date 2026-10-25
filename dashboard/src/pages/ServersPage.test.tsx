import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { Hosted, Server } from "@/api/types";
import { renderApp } from "@/test/render";
import {
  admin,
  apiError,
  hostedFixture,
  loggedInAs,
  member,
  server,
  serverFixture,
} from "@/test/server";

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
      readOnly: false,
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

  describe("hosted servers", () => {
    const hostedList = (servers: Hosted[], enabled = true) =>
      http.get("/api/hosted", () =>
        HttpResponse.json({ enabled, imageAllowlist: ["docker.io/mcp/"], servers }),
      );

    it("offers By image only when hosting is on", async () => {
      loggedInAs(admin);
      server.use(http.get("/api/servers", () => HttpResponse.json([])));
      const { user } = renderApp("/servers");
      await user.click(await screen.findByRole("button", { name: "Add server" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).queryByRole("tab", { name: "By image" })).not.toBeInTheDocument();
      expect(within(dialog).getByLabelText("URL")).toBeInTheDocument();
    });

    it("deploys an image: validates first, secrets sent once, then shows its progress", async () => {
      loggedInAs(admin);
      const rows: Hosted[] = [];
      let posted: Record<string, unknown> | undefined;
      server.use(
        http.get("/api/servers", () => HttpResponse.json([])),
        hostedList(rows),
        http.post("/api/hosted", async ({ request }) => {
          posted = (await request.json()) as Record<string, unknown>;
          if (posted.image === "evil/miner:1")
            return apiError(400, "image_not_allowed", "evil/miner:1 is not in the image allowlist");
          const created = hostedFixture({
            slug: posted.slug as string,
            name: posted.name as string,
            step: "queued",
            secretEnvKeys: Object.keys(posted.secretEnv as object),
          });
          rows.push(created);
          return HttpResponse.json(created, { status: 201 });
        }),
      );
      const { user } = renderApp("/servers");
      await user.click(await screen.findByRole("button", { name: "Add server" }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("tab", { name: "By image" }));
      expect(within(dialog).getByText("docker.io/mcp/")).toBeInTheDocument();

      await user.type(within(dialog).getByLabelText("Name"), "Sequential thinking");
      await user.type(within(dialog).getByLabelText("Slug"), "thinking");
      await user.type(within(dialog).getByLabelText("Image"), "evil/miner:1");
      await user.click(within(dialog).getByRole("button", { name: "Add variable" }));
      await user.type(within(dialog).getByLabelText("Variable 1 name"), "API_KEY");
      await user.click(within(dialog).getByRole("switch", { name: "Variable 1 secret" }));
      await user.click(within(dialog).getByRole("button", { name: "Deploy server" }));
      expect(await within(dialog).findByText(/the bridge runs it/)).toBeInTheDocument();
      expect(within(dialog).getByText("Required")).toBeInTheDocument();
      expect(posted).toBeUndefined();

      await user.type(within(dialog).getByLabelText("Command"), "node dist/index.js");
      await user.selectOptions(within(dialog).getByLabelText("Bridge build"), "musl");
      await user.type(within(dialog).getByLabelText("Variable 1 value"), "k3y");
      await user.click(within(dialog).getByRole("button", { name: "Deploy server" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "not in the image allowlist",
      );

      await user.clear(within(dialog).getByLabelText("Image"));
      await user.type(within(dialog).getByLabelText("Image"), "mcp/sequentialthinking:1.0");
      await user.click(within(dialog).getByRole("button", { name: "Deploy server" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(posted).toEqual({
        slug: "thinking",
        name: "Sequential thinking",
        image: "mcp/sequentialthinking:1.0",
        transport: "stdio",
        command: ["node", "dist/index.js"],
        port: 8080,
        path: "/mcp",
        libc: "musl",
        env: {},
        secretEnv: { API_KEY: "k3y" },
        authTokenEnv: null,
        egress: "none",
        size: "small",
      });
      const card = await screen.findByTestId("server-thinking");
      expect(within(card).getByText("Deploying")).toBeInTheDocument();
      expect(within(card).getByText("Queued")).toBeInTheDocument();
    });

    it("shows why a deploy failed, and retries it", async () => {
      loggedInAs(admin);
      let row = hostedFixture({
        status: "failed",
        step: "server",
        reason: "timed out at server: server: ImagePullBackOff (Back-off pulling image)",
      });
      server.use(
        http.get("/api/servers", () => HttpResponse.json([])),
        http.get("/api/hosted", () =>
          HttpResponse.json({ enabled: true, imageAllowlist: [], servers: [row] }),
        ),
        http.post("/api/hosted/:id/retry", () => {
          row = { ...row, status: "provisioning", step: "retry", reason: null };
          return HttpResponse.json(row);
        }),
      );
      const { user } = renderApp("/servers");
      const card = await screen.findByTestId("server-thinking");
      expect(within(card).getByText("Deploy failed")).toBeInTheDocument();
      expect(within(card).getByText(/ImagePullBackOff/)).toBeInTheDocument();
      expect(screen.queryByText("No MCP servers registered yet.")).not.toBeInTheDocument();
      await user.click(within(card).getByRole("button", { name: "Retry" }));
      expect(await within(card).findByText("Retrying")).toBeInTheDocument();
    });

    it("edits a running server: only changed fields, stored secrets kept, slug fixed", async () => {
      loggedInAs(admin);
      const row = hostedFixture({
        status: "ready",
        step: "ready",
        serverId: "44444444-4444-4444-4444-444444444444",
        secretEnvKeys: ["API_KEY"],
      });
      let patched: Record<string, unknown> | undefined;
      server.use(
        http.get("/api/servers", () =>
          HttpResponse.json([
            serverFixture({
              id: row.id,
              slug: "thinking",
              name: row.name,
              managedBy: "hosted",
              tools: [],
            }),
          ]),
        ),
        hostedList([row]),
        http.patch("/api/hosted/:id", async ({ request }) => {
          patched = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ ...row, status: "provisioning", step: "updating" });
        }),
      );
      const { user } = renderApp("/servers");
      const card = await screen.findByTestId("server-thinking");
      expect(within(card).getByText("Hosted")).toBeInTheDocument();
      expect(within(card).getByText(row.image)).toBeInTheDocument();
      expect(within(card).queryByRole("switch")).not.toBeInTheDocument();
      await user.click(within(card).getByRole("button", { name: "Edit Sequential thinking" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).queryByRole("tab")).not.toBeInTheDocument();
      expect(within(dialog).getByLabelText("Slug")).toBeDisabled();
      expect(within(dialog).getByLabelText("Transport")).toBeDisabled();
      expect(within(dialog).getByLabelText("Variable 1 value")).toHaveAttribute(
        "placeholder",
        expect.stringMatching(/leave blank to keep/),
      );
      await user.selectOptions(within(dialog).getByLabelText("Outbound network"), "internet");
      await user.click(within(dialog).getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(patched).toEqual({ egress: "internet" });
    });

    it("asks before deleting a hosted server", async () => {
      loggedInAs(admin);
      let deleted = false;
      const row = hostedFixture({ status: "failed", reason: "boom" });
      server.use(
        http.get("/api/servers", () => HttpResponse.json([])),
        http.get("/api/hosted", () =>
          HttpResponse.json({
            enabled: true,
            imageAllowlist: [],
            servers: [deleted ? { ...row, status: "deleting", step: "deleting" } : row],
          }),
        ),
        http.delete("/api/hosted/:id", () => {
          deleted = true;
          return HttpResponse.json({ ...row, status: "deleting" }, { status: 202 });
        }),
      );
      const { user } = renderApp("/servers");
      const card = await screen.findByTestId("server-thinking");
      await user.click(within(card).getByRole("button", { name: "Delete Sequential thinking" }));
      expect(deleted).toBe(false);
      const confirm = await screen.findByRole("alertdialog");
      await user.click(within(confirm).getByRole("button", { name: "Delete" }));
      expect(await within(card).findByText("Deleting")).toBeInTheDocument();
      expect(within(card).queryByRole("button", { name: /Edit/ })).not.toBeInTheDocument();
    });
  });
});
