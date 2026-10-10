import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { failures, requests, WC_BASE, wcHandlers } from "../test/fake-woocommerce.js";
import { WcClient, WcError } from "./client.js";

const server = setupServer(...wcHandlers());
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  requests.length = 0;
});
afterAll(() => server.close());

const client = (timeoutMs = 2000) =>
  new WcClient({
    baseUrl: WC_BASE,
    signingUrl: "http://store.local.test",
    consumerKey: "ck_test",
    consumerSecret: "cs_test",
    timeoutMs,
  });

async function expectWcError(promise: Promise<unknown>, kind: WcError["kind"], message?: RegExp) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(WcError);
  expect((err as WcError).kind).toBe(kind);
  if (message) expect((err as WcError).message).toMatch(message);
}

describe("WcClient", () => {
  it("sends OAuth-signed requests to the base URL with the caller's query params", async () => {
    const products = await client().get<unknown[]>("/products", { per_page: 5, search: undefined });
    expect(products).toHaveLength(1);
    const { url } = requests[0]!;
    expect(url.origin).toBe(WC_BASE);
    expect(url.searchParams.get("per_page")).toBe("5");
    expect(url.searchParams.has("search")).toBe(false);
    expect(url.searchParams.get("oauth_consumer_key")).toBe("ck_test");
    expect(url.searchParams.get("oauth_signature_method")).toBe("HMAC-SHA256");
    expect(url.searchParams.get("oauth_signature")).toMatch(/^[A-Za-z0-9+/]+=*$/);
    // The secret itself is never sent.
    expect(url.toString()).not.toContain("cs_test");
  });

  it("sends JSON bodies for writes", async () => {
    await client().put("/orders/100", { status: "completed" });
    expect(requests[0]).toMatchObject({ method: "PUT", body: { status: "completed" } });
  });

  it("maps 404 to not_found", async () => {
    await expectWcError(client().get("/orders/999"), "not_found");
  });

  it("maps 401 to auth with WooCommerce's reason", async () => {
    server.use(failures.unauthorized);
    await expectWcError(
      client().get("/orders"),
      "auth",
      /rejected the API credentials.*Invalid signature/,
    );
  });

  it("maps 400 to validation with WooCommerce's message", async () => {
    server.use(failures.badRequest);
    await expectWcError(
      client().post("/products", {}),
      "validation",
      /Invalid parameter\(s\): regular_price/,
    );
  });

  it("maps a 500 with an HTML body to upstream", async () => {
    server.use(failures.serverError);
    await expectWcError(client().get("/orders"), "upstream", /HTTP 500/);
  });

  it("times out instead of hanging", async () => {
    server.use(failures.hang);
    const started = Date.now();
    await expectWcError(client(200).get("/orders"), "timeout", /within 200ms/);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("maps connection failures to network", async () => {
    const unreachable = new WcClient({
      baseUrl: "http://127.0.0.1:1",
      signingUrl: "http://store.local.test",
      consumerKey: "ck_test",
      consumerSecret: "cs_test",
      timeoutMs: 2000,
    });
    server.close();
    try {
      await expectWcError(unreachable.get("/orders"), "network", /Could not reach WooCommerce/);
    } finally {
      server.listen({ onUnhandledRequest: "error" });
    }
  });
});
