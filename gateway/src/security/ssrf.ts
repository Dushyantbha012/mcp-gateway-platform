import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * SSRF guard for upstream MCP server URLs. An admin (or a stolen admin
 * session) who can point the gateway at any URL can make the gateway - which
 * sits inside the cluster - call the cloud metadata service, Postgres, the
 * Kubernetes API or any other internal service and read the reply back as a
 * "tool result". So a URL must resolve to a public address, unless its exact
 * hostname was allowlisted in the Helm values (the in-cluster WooCommerce MCP
 * server is the one legitimate private upstream).
 *
 * Enforced twice: when the URL is saved (clear error for the admin) and on
 * every connection (the address actually connected to is the address that was
 * checked, which defeats DNS rebinding).
 */

export interface SsrfPolicy {
  /** Exact hostnames that may resolve to private addresses. */
  allowedHosts: ReadonlySet<string>;
  /** Tests only: skip every check. Never set from configuration. */
  permissive?: boolean;
  /** Resolves a name to all of its addresses. Injectable for tests. */
  resolve?: (hostname: string) => Promise<string[]>;
}

/** The URL is refused. `message` is safe to show to an admin. */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

export const PERMISSIVE_POLICY: SsrfPolicy = { allowedHosts: new Set(), permissive: true };

export function policyFrom(allowedHosts: string[]): SsrfPolicy {
  return { allowedHosts: new Set(allowedHosts.map(normalizeHost)) };
}

const blocked = new BlockList();
const v4: [string, number, string][] = [
  ["0.0.0.0", 8, "this-network"],
  ["10.0.0.0", 8, "private (RFC 1918)"],
  ["100.64.0.0", 10, "carrier-grade NAT"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local / cloud metadata"],
  ["172.16.0.0", 12, "private (RFC 1918)"],
  ["192.0.0.0", 24, "IETF reserved"],
  ["192.0.2.0", 24, "documentation"],
  ["192.88.99.0", 24, "6to4 relay"],
  ["192.168.0.0", 16, "private (RFC 1918)"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
];
for (const [net, prefix] of v4) blocked.addSubnet(net, prefix, "ipv4");
const v6: [string, number][] = [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard-only
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
];
for (const [net, prefix] of v6) blocked.addSubnet(net, prefix, "ipv6");

/** Why an address is not allowed, or null if it is a public unicast address. */
export function blockedReason(address: string): string | null {
  const ip = address.replace(/^\[|\]$/g, "");
  const family = isIP(ip);
  if (family === 0) return "not an IP address";
  if (family === 4) return blocked.check(ip, "ipv4") ? describeV4(ip) : null;
  // IPv6 forms that carry an IPv4 address are judged by that address.
  const embedded = embeddedV4(ip);
  if (embedded) return blockedReason(embedded) ?? null;
  return blocked.check(ip, "ipv6") ? "private or reserved IPv6 range" : null;
}

function describeV4(ip: string): string {
  for (const [net, prefix, label] of v4) {
    const probe = new BlockList();
    probe.addSubnet(net, prefix, "ipv4");
    if (probe.check(ip, "ipv4")) return label;
  }
  return "reserved";
}

/** IPv4-mapped (::ffff:a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002::/16) addresses. */
function embeddedV4(ip: string): string | null {
  const groups = expandV6(ip);
  if (!groups) return null;
  const toV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (firstFiveZero && g5 === 0xffff) return toV4(g6, g7); // ::ffff:0:0/96
  if (firstFiveZero && g5 === 0 && (g6 !== 0 || g7 > 1)) return toV4(g6, g7); // deprecated ::a.b.c.d
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return toV4(g6, g7); // 64:ff9b::/96
  }
  if (g0 === 0x2002) return toV4(g1, g2); // 6to4
  return null;
}

function expandV6(ip: string): number[] | null {
  let text = ip.split("%")[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const parts = dotted[1].split(".").map(Number);
    if (parts.some((p) => p > 255)) return null;
    const hi = ((parts[0] << 8) | parts[1]).toString(16);
    const lo = ((parts[2] << 8) | parts[3]).toString(16);
    text = text.slice(0, -dotted[1].length) + `${hi}:${lo}`;
  }
  const [head, tail, extra] = text.split("::");
  if (extra !== undefined) return null;
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? left.length !== 8 : missing < 0) return null;
  const all = tail === undefined ? left : [...left, ...Array<string>(missing).fill("0"), ...right];
  const groups = all.map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

/** Lowercase, no trailing dot, no IPv6 brackets. */
export function normalizeHost(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
}

// Internal-only naming conventions. Refused before any DNS lookup, because a
// resolver inside the cluster would happily answer for them.
const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".svc", ".cluster.local", ".lan"];

function nameProblem(host: string): string | null {
  if (host === "localhost" || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return "is an internal hostname";
  }
  if (!host.includes(".")) return "is a single-label hostname (resolves inside the cluster)";
  return null;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  return (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);
}

function isAllowed(host: string, policy: SsrfPolicy): boolean {
  return !!policy.permissive || policy.allowedHosts.has(host);
}

/**
 * Validates a URL for use as an upstream. Resolves the hostname and refuses it
 * if ANY address is non-public (a name with one public and one private record
 * is exactly what an attacker would publish). Throws SsrfError.
 */
export async function checkUrl(raw: string, policy: SsrfPolicy): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError("is not a valid URL");
  }
  if (policy.permissive) return url;
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError("must use http or https");
  }
  if (url.username || url.password) {
    throw new SsrfError("must not contain credentials; use the credential field instead");
  }
  const host = normalizeHost(url.hostname);
  if (!host) throw new SsrfError("has no hostname");
  if (isAllowed(host, policy)) return url;

  if (isIP(host)) {
    const reason = blockedReason(host);
    if (reason) throw new SsrfError(`points at a ${reason} address, which is not allowed`);
    return url;
  }
  const problem = nameProblem(host);
  if (problem) throw new SsrfError(`${problem} and is not allowed`);

  let addresses: string[];
  try {
    addresses = await (policy.resolve ?? defaultResolve)(host);
  } catch {
    // Not blocked, just not resolvable right now: the health check will say
    // so (ENOTFOUND). Refusing here would reject a server that's merely down.
    return url;
  }
  for (const address of addresses) {
    const reason = blockedReason(address);
    if (reason) {
      throw new SsrfError(`resolves to a ${reason} address, which is not allowed`);
    }
  }
  return url;
}

/**
 * A `fetch` for the MCP transport that applies the policy to every request
 * (including each hop of a redirect the transport chooses to follow) and
 * validates the address at the moment of connecting, so a name that resolved
 * to a public address a millisecond ago cannot rebind to a private one.
 */
export function createGuardedFetch(policy: SsrfPolicy): typeof fetch {
  if (policy.permissive) return fetch;
  const resolve = policy.resolve ?? defaultResolve;
  const lookup: LookupFunction = (hostname, options, callback) => {
    void (async () => {
      const host = normalizeHost(hostname);
      const addresses = await resolve(host);
      if (!isAllowed(host, policy)) {
        for (const address of addresses) {
          const reason = blockedReason(address);
          if (reason) throw new SsrfError(`resolves to a ${reason} address, which is not allowed`);
        }
      }
      if (addresses.length === 0) throw new Error(`ENOTFOUND ${hostname}`);
      const entries = addresses.map((address) => ({ address, family: isIP(address) }));
      if (options.all) callback(null, entries);
      else callback(null, entries[0].address, entries[0].family);
    })().catch((err: Error) => (options.all ? callback(err, []) : callback(err, "", 0)));
  };
  const dispatcher = new Agent({ connect: { lookup } });
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    await checkUrl(url, policy);
    // Redirects are never followed inside fetch: a Location pointing at an IP
    // literal would skip the connect-time lookup. The caller (the MCP SDK's
    // same-origin policy) decides whether to follow, and each hop comes back
    // through this function.
    const redirect = init?.redirect === "error" ? "error" : "manual";
    return undiciFetch(url, { ...(init as object), redirect, dispatcher } as never);
  }) as typeof fetch;
}
