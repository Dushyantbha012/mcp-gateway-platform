import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeKubeApi, type FakeKubeApi } from "../test/fakeKubeApi.js";
import { K8sApiError, K8sSecretStore } from "./k8s.js";
import { MemoryCredentialStore, type CredentialStore } from "./store.js";

const NS = "urumi-upstreams";
let kube: FakeKubeApi;

beforeAll(async () => {
  kube = await startFakeKubeApi();
});
afterAll(async () => {
  await kube.close();
});

// The same behaviour is required of every implementation.
const implementations: [string, () => CredentialStore][] = [
  ["MemoryCredentialStore", () => new MemoryCredentialStore()],
  [
    "K8sSecretStore (fake API)",
    () => new K8sSecretStore({ apiUrl: kube.url, namespace: NS, token: async () => "test-token" }),
  ],
];

describe.each(implementations)("%s", (_name, make) => {
  it("stores, reads back, replaces and deletes a credential", async () => {
    const store = make();
    const id = randomUUID();
    expect(await store.get(id)).toBeNull();

    await store.put(id, "ghp_first");
    const first = await store.get(id);
    expect(first?.value).toBe("ghp_first");

    await store.put(id, "ghp_second"); // replace, not an error
    const second = await store.get(id);
    expect(second?.value).toBe("ghp_second");
    expect(second?.version).not.toBe(first?.version); // the registry rebuilds sessions on this

    await store.delete(id);
    expect(await store.get(id)).toBeNull();
    await store.delete(id); // deleting twice is fine
  });

  it("keeps unusual values byte-for-byte", async () => {
    const store = make();
    const id = randomUUID();
    const value = 'tok"en with spaces\nand newline, ünïcode ✓ \\ = ==';
    await store.put(id, value);
    expect((await store.get(id))?.value).toBe(value);
    await store.delete(id);
  });

  it("lists what it holds, with creation times", async () => {
    const store = make();
    const a = randomUUID();
    const b = randomUUID();
    await store.put(a, "x");
    await store.put(b, "y");
    const listed = await store.list();
    expect(listed.map((l) => l.serverId)).toEqual(expect.arrayContaining([a, b]));
    expect(listed.find((l) => l.serverId === a)!.createdAt.getTime()).toBeGreaterThan(0);
    await Promise.all([store.delete(a), store.delete(b)]);
  });
});

describe("K8sSecretStore against the Kubernetes API's behaviour", () => {
  const store = () =>
    new K8sSecretStore({ apiUrl: kube.url, namespace: NS, token: async () => "test-token" });

  it("writes an Opaque Secret in its own namespace with identifying labels", async () => {
    const id = randomUUID();
    await store().put(id, "s3cret");
    const stored = kube.secrets.get(NS)!.get(`mcp-upstream-${id}`)!;
    expect(stored.type).toBe("Opaque");
    expect(stored.metadata.labels).toMatchObject({
      "app.kubernetes.io/managed-by": "mcp-gateway",
      "urumi.ai/server-id": id,
    });
    expect(Buffer.from(stored.data!.credential, "base64").toString()).toBe("s3cret");
    // Never touches any other namespace.
    expect(
      [...kube.secrets.keys()].filter((k) => k !== NS && kube.secrets.get(k)!.size > 0),
    ).toEqual([]);
    await store().delete(id);
  });

  it("sends the service-account token on every request", async () => {
    const before = kube.requests.length;
    await store().get(randomUUID());
    expect(kube.requests.slice(before).every((r) => r.auth === "Bearer test-token")).toBe(true);
  });

  it("maps RBAC refusals to an error that names the status but not the secret", async () => {
    kube.failNext(
      403,
      'secrets is forbidden: User "system:serviceaccount:urumi:gateway" cannot create',
    );
    const err = await store()
      .put(randomUUID(), "super-secret-value")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(K8sApiError);
    expect((err as K8sApiError).status).toBe(403);
    expect((err as Error).message).toMatch(/HTTP 403/);
    expect((err as Error).message).not.toContain("super-secret-value");
  });

  it("reports an unreachable API without hanging", async () => {
    const dead = new K8sSecretStore({
      apiUrl: "http://127.0.0.1:1",
      namespace: NS,
      token: async () => "t",
      timeoutMs: 500,
    });
    await expect(dead.get(randomUUID())).rejects.toThrow(/unreachable/);
  });

  it("rejects ids that are not UUIDs (they become part of a URL path)", async () => {
    await expect(store().get("../../kube-system/secrets/x")).rejects.toThrow(/UUID/);
  });
});
