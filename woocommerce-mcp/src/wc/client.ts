import { signRequest, toQueryString } from "./oauth1.js";

/** Base class so tool handlers can turn any WooCommerce failure into a clear message. */
export class WcError extends Error {
  constructor(
    message: string,
    readonly kind: "not_found" | "auth" | "validation" | "upstream" | "timeout" | "network",
    readonly status?: number,
  ) {
    super(message);
    this.name = "WcError";
  }
}

export interface WcClientOptions {
  baseUrl: string;
  signingUrl: string;
  consumerKey: string;
  consumerSecret: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

type Query = Record<string, string | number | boolean | undefined>;

/** Minimal typed wrapper around the WooCommerce REST API (wc/v3). */
export class WcClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WcClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  get<T>(path: string, query: Query = {}): Promise<T> {
    return this.request<T>("GET", path, query);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, {}, body);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, {}, body);
  }

  delete<T>(path: string, query: Query = {}): Promise<T> {
    return this.request<T>("DELETE", path, query);
  }

  private async request<T>(method: string, path: string, query: Query, body?: unknown): Promise<T> {
    const fullPath = `/wp-json/wc/v3${path}`;
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params[k] = String(v);
    }
    const signed = signRequest({
      method,
      signingUrl: `${this.opts.signingUrl}${fullPath}`,
      params,
      consumerKey: this.opts.consumerKey,
      consumerSecret: this.opts.consumerSecret,
    });
    const url = `${this.opts.baseUrl}${fullPath}?${toQueryString(signed)}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new WcError(`WooCommerce did not respond within ${this.opts.timeoutMs}ms`, "timeout");
      }
      throw new WcError(
        `Could not reach WooCommerce: ${err instanceof Error ? err.message : String(err)}`,
        "network",
      );
    }

    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (res.ok) {
      if (data === undefined) {
        throw new WcError(`WooCommerce returned a non-JSON response (${res.status})`, "upstream");
      }
      return data as T;
    }

    // WooCommerce errors look like { code, message, data: { status } }.
    const wcMessage =
      data && typeof data === "object" && "message" in data && typeof data.message === "string"
        ? data.message
        : `HTTP ${res.status}`;
    if (res.status === 404) throw new WcError(wcMessage, "not_found", 404);
    if (res.status === 401 || res.status === 403) {
      throw new WcError(
        `WooCommerce rejected the API credentials: ${wcMessage}`,
        "auth",
        res.status,
      );
    }
    if (res.status >= 400 && res.status < 500) {
      throw new WcError(wcMessage, "validation", res.status);
    }
    throw new WcError(`WooCommerce error: ${wcMessage}`, "upstream", res.status);
  }
}
