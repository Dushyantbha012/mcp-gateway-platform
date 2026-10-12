import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { EffectiveTool, PermissionRule } from "@/api/types";
import { renderApp } from "@/test/render";
import { admin, loggedInAs, member, server, serverFixture } from "@/test/server";

const shop = serverFixture({
  slug: "woocommerce",
  name: "WooCommerce",
  tools: [
    { name: "woocommerce__list_orders", upstreamName: "list_orders" },
    { name: "woocommerce__update_order_status", upstreamName: "update_order_status" },
  ],
});
const disabled = serverFixture({ id: "4", slug: "old", name: "Old Server", enabled: false });

const denyUpdate: PermissionRule = {
  id: "rule-1",
  subject: { type: "role", role: "member" },
  serverSlug: "woocommerce",
  toolName: "update_order_status",
  effect: "deny",
  createdAt: new Date().toISOString(),
};

const effectiveFor = (rules: PermissionRule[]): EffectiveTool[] =>
  shop.tools.map((t) => {
    const denied = rules.some((r) => r.toolName === t.upstreamName && r.effect === "deny");
    return {
      name: t.name,
      serverSlug: "woocommerce",
      toolName: t.upstreamName,
      allowed: !denied,
      reason: denied ? "rule" : "default",
      ...(denied
        ? {
            rule: {
              subjectType: "role" as const,
              toolName: t.upstreamName,
              effect: "deny" as const,
            },
          }
        : {}),
    };
  });

/** A stateful fake of the permissions API, recording what the page sends. */
function fakePermissionsApi(initial: PermissionRule[]) {
  const state = {
    rules: [...initial],
    puts: [] as unknown[],
    deletes: [] as string[],
    effectiveQueries: [] as string[],
  };
  server.use(
    http.get("/api/servers", () => HttpResponse.json([shop, disabled])),
    http.get("/api/users", () => HttpResponse.json([admin, member])),
    http.get("/api/permissions", () => HttpResponse.json(state.rules)),
    http.get("/api/permissions/effective", ({ request }) => {
      state.effectiveQueries.push(new URL(request.url).search);
      return HttpResponse.json(effectiveFor(state.rules));
    }),
    http.put("/api/permissions", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      state.puts.push(body);
      state.rules = [
        ...state.rules.filter(
          (r) => !(r.toolName === body.toolName && r.serverSlug === body.serverSlug),
        ),
        {
          id: "new",
          subject: body.userId
            ? { type: "user", userId: body.userId as string }
            : { type: "role", role: "member" },
          serverSlug: body.serverSlug as string,
          toolName: body.toolName as string | null,
          effect: body.effect as "allow" | "deny",
          createdAt: new Date().toISOString(),
        },
      ];
      return HttpResponse.json({ id: "new", effect: body.effect });
    }),
    http.delete("/api/permissions/:id", ({ params }) => {
      state.deletes.push(params.id as string);
      state.rules = state.rules.filter((r) => r.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return state;
}

const ruleSelect = (tool: string) => screen.findByLabelText(new RegExp(`^Rule for .* on ${tool}$`));

describe("Permissions page", () => {
  it("shows each enabled server's tools with their rule and the result for members", async () => {
    loggedInAs(admin);
    fakePermissionsApi([denyUpdate]);
    renderApp("/permissions");

    expect(await screen.findByRole("heading", { name: "WooCommerce" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Old Server" })).not.toBeInTheDocument();
    expect(await ruleSelect("update_order_status")).toHaveValue("deny");
    expect(await ruleSelect("list_orders")).toHaveValue("inherit");

    const row = (await ruleSelect("update_order_status")).closest("tr")!;
    expect(await within(row).findByText("Hidden")).toBeInTheDocument();
    expect(within(row).getByText("role tool rule")).toBeInTheDocument();
    const other = (await ruleSelect("list_orders")).closest("tr")!;
    expect(await within(other).findByText("Allowed")).toBeInTheDocument();
    expect(within(other).getByText("no rule")).toBeInTheDocument();
  });

  it("denying a tool sends a role rule, then the row shows it hidden", async () => {
    loggedInAs(admin);
    const api = fakePermissionsApi([]);
    const { user } = renderApp("/permissions");

    await user.selectOptions(await ruleSelect("list_orders"), "deny");
    await waitFor(() =>
      expect(api.puts).toEqual([
        { role: "member", serverSlug: "woocommerce", toolName: "list_orders", effect: "deny" },
      ]),
    );
    const row = (await ruleSelect("list_orders")).closest("tr")!;
    expect(await within(row).findByText("Hidden")).toBeInTheDocument();
    expect(await ruleSelect("list_orders")).toHaveValue("deny");
  });

  it("the whole-server row sends a rule with no tool name", async () => {
    loggedInAs(admin);
    const api = fakePermissionsApi([]);
    const { user } = renderApp("/permissions");
    await user.selectOptions(await ruleSelect("Whole server"), "deny");
    await waitFor(() =>
      expect(api.puts).toEqual([
        { role: "member", serverSlug: "woocommerce", toolName: null, effect: "deny" },
      ]),
    );
  });

  it("choosing Inherit deletes the existing rule", async () => {
    loggedInAs(admin);
    const api = fakePermissionsApi([denyUpdate]);
    const { user } = renderApp("/permissions");
    await user.selectOptions(await ruleSelect("update_order_status"), "inherit");
    await waitFor(() => expect(api.deletes).toEqual(["rule-1"]));
    await waitFor(async () =>
      expect(await ruleSelect("update_order_status")).toHaveValue("inherit"),
    );
  });

  it("editing for one person targets that user, and doesn't show the role's rules as theirs", async () => {
    loggedInAs(admin);
    const api = fakePermissionsApi([denyUpdate]);
    const { user } = renderApp("/permissions");

    await screen.findByRole("option", { name: /Max Member/ });
    await user.selectOptions(screen.getByLabelText("Applies to"), `user:${member.id}`);
    // The role rule isn't this person's own rule.
    await waitFor(async () =>
      expect(
        await screen.findByLabelText(`Rule for ${member.email} on update_order_status`),
      ).toHaveValue("inherit"),
    );
    await user.selectOptions(
      screen.getByLabelText(`Rule for ${member.email} on update_order_status`),
      "allow",
    );
    await waitFor(() =>
      expect(api.puts).toEqual([
        {
          userId: member.id,
          serverSlug: "woocommerce",
          toolName: "update_order_status",
          effect: "allow",
        },
      ]),
    );
    expect(api.effectiveQueries.some((q) => q === `?userId=${member.id}`)).toBe(true);
    expect(api.effectiveQueries[0]).toBe("?role=member");
  });

  it("offers only members to choose from, not admins", async () => {
    loggedInAs(admin);
    fakePermissionsApi([]);
    renderApp("/permissions");
    const select = await screen.findByLabelText("Applies to");
    await screen.findByRole("option", { name: /Max Member/ });
    const options = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["All members", `Max Member (${member.email})`]);
  });

  it("shows the gateway's message when a change fails", async () => {
    loggedInAs(admin);
    fakePermissionsApi([]);
    server.use(
      http.put("/api/permissions", () =>
        HttpResponse.json(
          { error: { code: "invalid_request", message: "No server with slug 'woocommerce'" } },
          { status: 400 },
        ),
      ),
    );
    const { user } = renderApp("/permissions");
    await user.selectOptions(await ruleSelect("list_orders"), "deny");
    expect(await screen.findByText("No server with slug 'woocommerce'")).toBeInTheDocument();
    expect(await ruleSelect("list_orders")).toHaveValue("inherit");
  });
});
