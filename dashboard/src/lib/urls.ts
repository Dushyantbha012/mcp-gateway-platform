/**
 * Only same-app paths: `?next=https://evil.test` must not become an open
 * redirect. Browsers treat a backslash like "/" in URLs, so "/\evil.test"
 * would be the protocol-relative "//evil.test" - rejected too.
 */
export function safeNext(next: string | null): string {
  return next && /^\/(?![/\\])/.test(next) ? next : "/servers";
}

/** An invite link relative to this dashboard when the gateway has no DASHBOARD_URL. */
export function absoluteInviteUrl(url: string) {
  return url.startsWith("/") ? `${window.location.origin}${url}` : url;
}
