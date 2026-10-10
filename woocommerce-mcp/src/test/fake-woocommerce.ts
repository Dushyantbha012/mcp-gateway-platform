import { delay, getResponse, http, HttpResponse, type RequestHandler } from "msw";
import type { WcOrder, WcProduct } from "../wc/dto.js";

/** Fake WooCommerce REST API for tests: an in-memory store behind msw handlers. */
export const WC_BASE = "http://wc.test";
const API = `${WC_BASE}/wp-json/wc/v3`;

export function product(overrides: Partial<WcProduct> = {}): WcProduct {
  return {
    id: 10,
    name: "Urumi Coffee Mug",
    sku: "DEMO-MUG",
    status: "publish",
    price: "12.00",
    regular_price: "12.00",
    stock_status: "instock",
    stock_quantity: null,
    permalink: "http://store.local.test/product/urumi-coffee-mug/",
    date_created: "2026-10-10T09:00:00",
    ...overrides,
  };
}

export function order(overrides: Partial<WcOrder> = {}): WcOrder {
  return {
    id: 100,
    number: "100",
    status: "processing",
    currency: "USD",
    total: "12.00",
    payment_method_title: "Cash on delivery",
    date_created: "2026-10-10T10:30:00",
    billing: { first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" },
    line_items: [{ product_id: 10, name: "Urumi Coffee Mug", quantity: 1, total: "12.00" }],
    customer_note: "",
    ...overrides,
  };
}

const notFound = (code: string) =>
  HttpResponse.json({ code, message: "Invalid ID.", data: { status: 404 } }, { status: 404 });

/** Records the last request so tests can assert on what was sent. */
export const requests: { method: string; url: URL; body: unknown }[] = [];

export function wcHandlers() {
  const products = [product()];
  const orders = [order()];
  const record = async (request: Request) => {
    const body = request.method === "GET" ? undefined : await request.clone().json();
    requests.push({ method: request.method, url: new URL(request.url), body });
  };

  return [
    http.get(`${API}/products`, async ({ request }) => {
      await record(request);
      return HttpResponse.json(products);
    }),
    http.post(`${API}/products`, async ({ request }) => {
      await record(request);
      const body = (await request.json()) as Partial<WcProduct>;
      const created = product({ ...body, id: 11, price: body.regular_price ?? "0" });
      products.push(created);
      return HttpResponse.json(created, { status: 201 });
    }),
    http.get(`${API}/orders`, async ({ request }) => {
      await record(request);
      return HttpResponse.json(orders);
    }),
    http.get(`${API}/orders/:id`, async ({ request, params }) => {
      await record(request);
      const found = orders.find((o) => o.id === Number(params.id));
      return found ? HttpResponse.json(found) : notFound("woocommerce_rest_shop_order_invalid_id");
    }),
    http.put(`${API}/orders/:id`, async ({ request, params }) => {
      await record(request);
      const found = orders.find((o) => o.id === Number(params.id));
      if (!found) return notFound("woocommerce_rest_shop_order_invalid_id");
      const body = (await request.json()) as { status: string };
      found.status = body.status;
      return HttpResponse.json(found);
    }),
  ];
}

/** Handlers that make every WooCommerce call fail in a specific way. */
export const failures = {
  unauthorized: http.all(`${API}/*`, () =>
    HttpResponse.json(
      {
        code: "woocommerce_rest_authentication_error",
        message: "Invalid signature - provided signature does not match.",
        data: { status: 401 },
      },
      { status: 401 },
    ),
  ),
  serverError: http.all(
    `${API}/*`,
    () => new HttpResponse("<html>Fatal error</html>", { status: 500 }),
  ),
  badRequest: http.all(`${API}/*`, () =>
    HttpResponse.json(
      {
        code: "rest_invalid_param",
        message: "Invalid parameter(s): regular_price",
        data: { status: 400 },
      },
      { status: 400 },
    ),
  ),
  hang: http.all(`${API}/*`, async () => {
    await delay("infinite");
    return HttpResponse.json([]);
  }),
};

/**
 * A fetch function backed by msw handlers, without msw's global
 * interception. Used where the test process also makes real HTTP calls
 * (the MCP SDK client), which global interception interferes with.
 * Honours AbortSignal so timeouts behave like real fetch.
 */
export function fakeFetch(getHandlers: () => RequestHandler[]): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const pending = getResponse(getHandlers(), request).then(
      (res) => res ?? new Response("no handler", { status: 599 }),
    );
    const signal = init?.signal;
    if (!signal) return pending;
    return Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
    ]);
  };
}
