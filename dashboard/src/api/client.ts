/** An error response from the gateway: `{ error: { code, message } }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized: () => void = () => {};

/**
 * Called when any request comes back 401 (logged out elsewhere, session
 * expired, user disabled), so the app can send the user to the login page.
 */
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

/**
 * The one way the dashboard talks to the gateway. Same-origin `/api/...`
 * (the Ingress routes it to the gateway), so the browser attaches the
 * HttpOnly session cookie by itself - page scripts never see it - and adds
 * the Origin header the gateway checks on every change.
 */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | undefined)?.error;
    // Login and invite pages show their own 401s; don't redirect from them.
    if (res.status === 401 && !path.startsWith("/auth/")) onUnauthorized();
    throw new ApiError(
      res.status,
      err?.code ?? "http_error",
      err?.message ?? `Request failed (HTTP ${res.status})`,
    );
  }
  return data as T;
}

export const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : "Something went wrong";
