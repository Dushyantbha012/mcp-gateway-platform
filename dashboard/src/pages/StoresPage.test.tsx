import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { Store, StoreList } from "@/api/types";
import { renderApp } from "@/test/render";
import { admin, apiError, loggedInAs, member, server, serverFixture } from "@/test/server";

function storeFixture(overrides: Partial<Store> = {}): Store {
  return {
    id: "44444444-4444-4444-4444-444444444444",
    slug: "acme",
    name: "Acme",
    kind: "provisioned",
    status: "ready",
    step: "ready",
    reason: null,
    url: "http://acme.store.local.test",
    namespace: "store-acme",
    serverId: "44444444-4444-4444-4444-444444444444",
    owner: { id: member.id, email: member.email },
    canManage: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const list = (stores: Store[], over: Partial<StoreList> = {}): StoreList => ({
  enabled: true,
  maxPerUser: 2,
  stores,
  ...over,
});

describe("Stores page", () => {
  it("lists stores with status, progress and a storefront link", async () => {
    loggedInAs(member);
    server.use(
      http.get("/api/stores", () =>
        HttpResponse.json(
          list([
            storeFixture({
              slug: "woocommerce",
              name: "Default store",
              kind: "default",
              owner: null,
              canManage: false,
              url: "http://store.local.test",
            }),
            storeFixture(),
            storeFixture({
              id: "55555555-5555-5555-5555-555555555555",
              slug: "globex",
              name: "Globex",
              status: "provisioning",
              step: "bootstrap",
              reason: "installing WordPress and WooCommerce",
              url: null,
            }),
          ]),
        ),
      ),
    );
    renderApp("/stores");

    const def = await screen.findByTestId("store-woocommerce");
    expect(within(def).getByText("Default")).toBeInTheDocument();
    expect(within(def).getByText("Helm")).toBeInTheDocument();
    expect(within(def).queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();

    const acme = screen.getByTestId("store-acme");
    expect(within(acme).getByText("Ready")).toBeInTheDocument();
    expect(within(acme).getByRole("link", { name: /acme\.store\.local\.test/ })).toHaveAttribute(
      "href",
      "http://acme.store.local.test",
    );

    const globex = screen.getByTestId("store-globex");
    expect(within(globex).getByText("Provisioning")).toBeInTheDocument();
    expect(within(globex).getByText("Installing WooCommerce")).toBeInTheDocument();
    expect(within(globex).getByText("installing WordPress and WooCommerce")).toBeInTheDocument();

    expect(screen.getByText("You have 2 of 2 stores.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create store" })).toBeDisabled();
  });

  it("creates a store and shows it", async () => {
    loggedInAs(member);
    let stores: Store[] = [];
    let posted: unknown;
    server.use(
      http.get("/api/stores", () => HttpResponse.json(list(stores))),
      http.post("/api/stores", async ({ request }) => {
        posted = await request.json();
        stores = [storeFixture({ status: "provisioning", step: null, url: null })];
        return HttpResponse.json(stores[0], { status: 201 });
      }),
    );
    const { user } = renderApp("/stores");
    await user.click(await screen.findByRole("button", { name: "Create store" }));
    await user.type(screen.getByLabelText("Store name"), "Acme");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Create store" }),
    );

    expect(posted).toEqual({ name: "Acme" });
    const row = await screen.findByTestId("store-acme");
    expect(within(row).getByText("Provisioning")).toBeInTheDocument();
    expect(within(row).getByText("Queued")).toBeInTheDocument();
  });

  it("shows the gateway's refusal in the dialog", async () => {
    loggedInAs(member);
    server.use(
      http.get("/api/stores", () => HttpResponse.json(list([]))),
      http.post("/api/stores", () =>
        apiError(409, "conflict", "The name 'acme' is already in use"),
      ),
    );
    const { user } = renderApp("/stores");
    await user.click(await screen.findByRole("button", { name: "Create store" }));
    await user.type(screen.getByLabelText("Store name"), "Acme");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Create store" }),
    );
    expect(await screen.findByText("The name 'acme' is already in use")).toBeInTheDocument();
  });

  it("offers retry for a failed store and shows why it failed", async () => {
    loggedInAs(member);
    let retried = false;
    server.use(
      http.get("/api/stores", () =>
        HttpResponse.json(
          list([
            storeFixture({
              status: retried ? "provisioning" : "failed",
              step: retried ? "retry" : "bootstrap",
              reason: retried ? null : "bootstrap failed: BackoffLimitExceeded",
            }),
          ]),
        ),
      ),
      http.post("/api/stores/:id/retry", () => {
        retried = true;
        return HttpResponse.json(storeFixture({ status: "provisioning", step: "retry" }));
      }),
    );
    const { user } = renderApp("/stores");
    const row = await screen.findByTestId("store-acme");
    expect(within(row).getByText("bootstrap failed: BackoffLimitExceeded")).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: /Retry/ }));
    expect(await within(row).findByText("Retrying")).toBeInTheDocument();
  });

  it("deletes after confirmation, and hides delete from people who can't", async () => {
    loggedInAs(admin);
    let deleted = "";
    server.use(
      http.get("/api/stores", () =>
        HttpResponse.json(
          list([
            storeFixture({
              status: deleted ? "deleting" : "ready",
              step: deleted ? "deleting" : "ready",
            }),
            storeFixture({
              id: "66666666-6666-6666-6666-666666666666",
              slug: "other",
              name: "Other",
              canManage: false,
            }),
          ]),
        ),
      ),
      http.delete("/api/stores/:id", ({ params }) => {
        deleted = String(params.id);
        return HttpResponse.json(storeFixture({ status: "deleting" }), { status: 202 });
      }),
    );
    const { user } = renderApp("/stores");
    const row = await screen.findByTestId("store-acme");
    expect(
      within(screen.getByTestId("store-other")).queryByRole("button", { name: /Delete/ }),
    ).not.toBeInTheDocument();

    await user.click(within(row).getByRole("button", { name: "Delete Acme" }));
    await user.click(await screen.findByRole("button", { name: "Delete store" }));
    await waitFor(() => expect(deleted).toBe("44444444-4444-4444-4444-444444444444"));
    expect(await within(row).findByText("Deleting")).toBeInTheDocument();
  });

  it("says so when provisioning is off, without a create button", async () => {
    loggedInAs(member);
    server.use(http.get("/api/stores", () => HttpResponse.json(list([], { enabled: false }))));
    renderApp("/stores");
    expect(await screen.findByText(/isn't enabled on this gateway/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create store" })).not.toBeInTheDocument();
  });
});

describe("Servers page with a store's server", () => {
  it("marks it as managed and offers no edit, toggle or remove", async () => {
    loggedInAs(admin);
    server.use(
      http.get("/api/servers", () =>
        HttpResponse.json([serverFixture({ slug: "acme", name: "Acme", managedBy: "store" })]),
      ),
    );
    renderApp("/servers");
    const card = await screen.findByTestId("server-acme");
    expect(within(card).getByText("Managed by Stores")).toBeInTheDocument();
    expect(within(card).queryByRole("switch")).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /Edit/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Check Acme now" })).toBeInTheDocument();
  });
});
