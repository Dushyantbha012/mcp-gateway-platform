import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { AuditEntry } from "@/api/types";
import { AUDIT_PAGE } from "@/api/hooks";
import { renderApp } from "@/test/render";
import { admin, loggedInAs, member, server, serverFixture } from "@/test/server";

const entry = (id: number, overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  id: String(id),
  ts: new Date().toISOString(),
  userId: member.id,
  userEmail: member.email,
  apiKeyId: "k1",
  source: "mcp",
  server: "woocommerce",
  tool: "woocommerce__list_orders",
  durationMs: 42,
  outcome: "success",
  error: null,
  ...overrides,
});

describe("Audit page", () => {
  it("renders who/what/when/how long/outcome, and sends filters to the gateway", async () => {
    loggedInAs(admin);
    const queries: URLSearchParams[] = [];
    server.use(
      http.get("/api/users", () => HttpResponse.json([admin, member])),
      http.get("/api/servers", () => HttpResponse.json([serverFixture()])),
      http.get("/api/audit", ({ request }) => {
        const params = new URL(request.url).searchParams;
        queries.push(params);
        if (params.get("outcome") === "timeout") {
          return HttpResponse.json([
            entry(2, {
              outcome: "timeout",
              durationMs: 10_000,
              error: "Upstream 'woocommerce' timed out after 10000ms",
            }),
          ]);
        }
        return HttpResponse.json([entry(1)]);
      }),
    );
    const { user } = renderApp("/audit");
    const row = await screen.findByTestId("audit-row");
    expect(row).toHaveTextContent(member.email);
    expect(row).toHaveTextContent("woocommerce__list_orders");
    expect(row).toHaveTextContent("42 ms");
    expect(within(row).getByText("Success")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Filter by outcome"), "timeout");
    await user.selectOptions(screen.getByLabelText("Filter by user"), member.id);
    const timeoutRow = await screen.findByText(/timed out after 10000ms/);
    expect(timeoutRow.closest("tr")).toHaveTextContent("Timeout");
    expect(timeoutRow.closest("tr")).toHaveTextContent("10.0 s");
    const last = queries[queries.length - 1];
    expect(last.get("outcome")).toBe("timeout");
    expect(last.get("userId")).toBe(member.id);
    expect(last.get("limit")).toBe(String(AUDIT_PAGE));
  });

  it("pages back with the keyset cursor", async () => {
    loggedInAs(admin);
    const firstPage = Array.from({ length: AUDIT_PAGE }, (_, i) => entry(1000 - i));
    server.use(
      http.get("/api/users", () => HttpResponse.json([admin])),
      http.get("/api/servers", () => HttpResponse.json([])),
      http.get("/api/audit", ({ request }) => {
        const before = new URL(request.url).searchParams.get("before");
        return HttpResponse.json(
          before === String(1000 - AUDIT_PAGE + 1)
            ? [entry(1, { tool: "oldest__tool" })]
            : firstPage,
        );
      }),
    );
    const { user } = renderApp("/audit");
    expect(await screen.findAllByTestId("audit-row")).toHaveLength(AUDIT_PAGE);
    await user.click(screen.getByRole("button", { name: "Load older entries" }));
    expect(await screen.findByText("oldest__tool")).toBeInTheDocument();
    expect(screen.getAllByTestId("audit-row")).toHaveLength(AUDIT_PAGE + 1);
    expect(screen.queryByRole("button", { name: "Load older entries" })).not.toBeInTheDocument();
  });
});
