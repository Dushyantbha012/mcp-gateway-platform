import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render";
import { loggedInAs, member, server } from "@/test/server";

const pending = {
  id: "7d9a2c1e-0000-4000-8000-000000000001",
  name: "woocommerce__create_product",
  args: { name: "Mug", regular_price: "9.99" },
  tool: {
    name: "woocommerce__create_product",
    server: "woocommerce",
    description: "Create a simple product in the store.",
    readOnly: false,
    destructive: false,
  },
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

describe("Approvals page", () => {
  it("shows what an MCP client asked for, with the tool's own description, and answers it", async () => {
    loggedInAs(member);
    const answered: string[] = [];
    let items = [pending];
    server.use(
      http.get("/api/approvals", () => HttpResponse.json(items)),
      http.post("/api/approvals/:id/approve", ({ params }) => {
        answered.push(`approve ${String(params.id)}`);
        items = [];
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { user } = renderApp("/approvals");
    expect(await screen.findByText("woocommerce__create_product")).toBeInTheDocument();
    expect(screen.getByText(/Create a simple product/)).toBeInTheDocument();
    expect(screen.getByText(/"regular_price": "9.99"/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(answered).toEqual([`approve ${pending.id}`]);
    expect(await screen.findByText("Nothing waiting")).toBeInTheDocument();
  });
});
