import { describe, expect, it } from "vitest";
import {
  blockedReason,
  checkUrl,
  createGuardedFetch,
  policyForServer,
  policyFrom,
  SsrfError,
} from "./ssrf.js";

const policy = (map: Record<string, string[]> = {}, allowed: string[] = []) => ({
  ...policyFrom(allowed),
  resolve: async (host: string) => {
    if (!(host in map)) throw new Error("ENOTFOUND");
    return map[host];
  },
});

describe("blockedReason (addresses)", () => {
  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "0.0.0.0",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "64:ff9b::7f00:1",
    "2002:7f00:1::1",
    "2002:a9fe:a9fe::",
    "[::1]",
  ])("blocks %s", (ip) => {
    expect(blockedReason(ip)).not.toBeNull();
  });

  it.each(["8.8.8.8", "1.1.1.1", "140.82.112.3", "172.32.0.1", "172.15.0.1", "2606:4700::1111"])(
    "allows %s",
    (ip) => {
      expect(blockedReason(ip)).toBeNull();
    },
  );
});

describe("checkUrl", () => {
  const p = policy({
    "mcp.example.com": ["93.184.216.34"],
    "mixed.example.com": ["93.184.216.34", "10.0.0.7"],
    "evil.example.com": ["169.254.169.254"],
    "ipv6.example.com": ["::1"],
    // search domains: resolves inside the cluster to a Service IP
    "kubernetes.default": ["10.43.0.1"],
  });

  it.each([
    "http://127.0.0.1/mcp",
    "http://127.0.0.1:8080/",
    "http://localhost/",
    "http://LOCALHOST:3000/",
    "http://localhost./",
    "http://foo.localhost/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://169.254.169.254./",
    "http://2130706433/", // decimal 127.0.0.1
    "http://0x7f000001/", // hex
    "http://0x7f.0.0.1/",
    "http://017700000001/", // octal
    "http://127.1/", // shortened
    "http://0/",
    "http://10.1.2.3/",
    "http://192.168.0.1/",
    "http://172.20.0.5:6443/",
    "http://platform-gateway-postgres:5432/",
    "http://kubernetes.default/",
    "http://kubernetes.default.svc/",
    "http://platform-store-wordpress.urumi.svc.cluster.local/",
    "http://thing.internal/",
    "http://printer.local/",
    "http://evil.example.com/", // resolves to metadata
    "http://mixed.example.com/", // one private record is enough
    "http://ipv6.example.com/",
    "http://user:pass@mcp.example.com/",
    "http://:pw@mcp.example.com/",
    "ftp://mcp.example.com/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
    "",
  ])("rejects %s", async (url) => {
    await expect(checkUrl(url, p)).rejects.toBeInstanceOf(SsrfError);
  });

  it.each([
    "https://mcp.example.com/mcp",
    "http://mcp.example.com:8443/x?y=1",
    "https://MCP.EXAMPLE.COM./mcp",
    "https://8.8.8.8/mcp",
    "https://[2606:4700::1111]/mcp",
  ])("accepts %s", async (url) => {
    await expect(checkUrl(url, p)).resolves.toBeInstanceOf(URL);
  });

  it("does not refuse a name that simply does not resolve (the health check reports it)", async () => {
    await expect(checkUrl("https://down.example.com/", p)).resolves.toBeInstanceOf(URL);
  });

  it("lets an allowlisted host through, and only that exact host", async () => {
    const allowed = policy({}, ["platform-store-woocommerce-mcp"]);
    await expect(
      checkUrl("http://platform-store-woocommerce-mcp/mcp", allowed),
    ).resolves.toBeInstanceOf(URL);
    await expect(checkUrl("http://platform-gateway-postgres:5432/", allowed)).rejects.toThrow();
    await expect(checkUrl("http://platform-store-woocommerce-mcp.svc/", allowed)).rejects.toThrow();
    await expect(checkUrl("http://10.0.0.5/", allowed)).rejects.toThrow();
  });

  it("explains the refusal without leaking anything beyond the address class", async () => {
    await expect(checkUrl("http://169.254.169.254/", p)).rejects.toThrow(/link-local/);
    await expect(checkUrl("http://evil.example.com/", p)).rejects.toThrow(/resolves to a/);
  });
});

describe("createGuardedFetch", () => {
  it("refuses a private literal before any connection", async () => {
    const f = createGuardedFetch(policy());
    await expect(f("http://127.0.0.1:1/")).rejects.toBeInstanceOf(SsrfError);
  });

  it("catches DNS rebinding: public at check time, private at connect time", async () => {
    let calls = 0;
    const f = createGuardedFetch({
      ...policyFrom([]),
      resolve: async () => (++calls === 1 ? ["93.184.216.34"] : ["127.0.0.1"]),
    });
    const err = await f("http://rebind.example.com:8099/").catch((e: unknown) => e);
    expect(calls).toBeGreaterThanOrEqual(2);
    // the connect-time lookup refused the second answer
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(SsrfError);
  });
});

describe("policyForServer", () => {
  const base = policyFrom([]);
  const mcp = "http://woocommerce-mcp.store-acme.svc.cluster.local:3000/mcp";
  const resolve = async () => ["10.43.0.12"];

  it("lets a managed row reach its own in-cluster service", async () => {
    const policy = { ...policyForServer(base, { url: mcp, managed_by: "store" }), resolve };
    await expect(checkUrl(mcp, policy)).resolves.toBeInstanceOf(URL);
    // ...and only that one.
    await expect(
      checkUrl("http://woocommerce-mcp.store-globex.svc.cluster.local:3000/mcp", policy),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("gives unmanaged rows no exception, even for the same URL", async () => {
    const policy = { ...policyForServer(base, { url: mcp, managed_by: null }), resolve };
    await expect(checkUrl(mcp, policy)).rejects.toBeInstanceOf(SsrfError);
  });

  it.each([
    "http://postgres.urumi.svc.cluster.local:5432/",
    "http://kubernetes.default.svc.cluster.local/",
    "http://store-acme.svc.cluster.local/",
    "http://10.43.0.12:3000/mcp",
  ])("never extends the exception to %s, even on a managed row", (url) => {
    expect(policyForServer(base, { url, managed_by: "store" })).toBe(base);
  });
});
