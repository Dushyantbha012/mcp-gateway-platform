import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeKubeApi, type FakeKubeApi } from "../test/fakeKubeApi.js";
import { K8sApiError, K8sClient, resourcePath, type K8sObject } from "./client.js";

let kube: FakeKubeApi;
let client: K8sClient;

beforeAll(async () => {
  kube = await startFakeKubeApi();
  client = new K8sClient({ apiUrl: kube.url, token: async () => "test-token" });
});
afterAll(async () => {
  await kube.close();
});

const ns = (name: string): K8sObject => ({
  apiVersion: "v1",
  kind: "Namespace",
  metadata: { name, labels: { "urumi.ai/managed-by": "provisioner" } },
});
const deployment = (namespace: string, name: string, replicas = 1): K8sObject => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name, namespace, labels: { app: name } },
  spec: { replicas },
});

describe("resourcePath", () => {
  it("builds core, grouped and cluster-scoped paths", () => {
    expect(resourcePath("v1", "Secret", "a", "b")).toBe("/api/v1/namespaces/a/secrets/b");
    expect(resourcePath("apps/v1", "Deployment", "a")).toBe(
      "/apis/apps/v1/namespaces/a/deployments",
    );
    expect(resourcePath("networking.k8s.io/v1", "NetworkPolicy", "a", "p")).toBe(
      "/apis/networking.k8s.io/v1/namespaces/a/networkpolicies/p",
    );
    expect(resourcePath("v1", "Namespace", undefined, "x")).toBe("/api/v1/namespaces/x");
  });

  it("refuses unknown kinds and namespaced kinds without a namespace", () => {
    expect(() => resourcePath("v1", "Node")).toThrow(/unsupported/);
    expect(() => resourcePath("v1", "Secret")).toThrow(/namespace/);
  });

  it("encodes names so they cannot escape the path", () => {
    expect(resourcePath("v1", "Secret", "a", "../b")).toBe("/api/v1/namespaces/a/secrets/..%2Fb");
  });
});

describe("K8sClient", () => {
  it("server-side applies: creates, then converges, as the provisioner's field manager", async () => {
    await client.apply(ns("store-a"));
    const created = await client.apply(deployment("store-a", "web"));
    expect(created.metadata.resourceVersion).toBeTruthy();
    const req = kube.requests.at(-1)!;
    expect(req.method).toBe("PATCH");
    expect(req.contentType).toBe("application/apply-patch+yaml");
    expect(req.path).toMatch(/fieldManager=urumi-provisioner&force=true/);

    kube.setStatus("deployments", "store-a", "web", { readyReplicas: 1 });
    await client.apply(deployment("store-a", "web", 2));
    const got = await client.get(deployment("store-a", "web"));
    expect((got!.spec as { replicas: number }).replicas).toBe(2);
    // A re-apply doesn't wipe what the controller reported.
    expect(got!.status).toEqual({ readyReplicas: 1 });
  });

  it("returns null for a missing object", async () => {
    expect(await client.get(deployment("store-a", "nope"))).toBeNull();
  });

  it("creates once and reports an existing object instead of failing", async () => {
    const secret: K8sObject = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "db", namespace: "store-a" },
      data: { password: "eA==" },
    };
    expect(await client.create(secret)).toBe(true);
    expect(await client.create({ ...secret, data: { password: "eQ==" } })).toBe(false);
    expect(kube.get("secrets", "store-a", "db")!.data).toEqual({ password: "eA==" });
  });

  it("lists by label selector", async () => {
    await client.apply(ns("store-b"));
    await client.apply({ ...ns("other"), metadata: { name: "other" } });
    const managed = await client.list("v1", "Namespace", {
      labelSelector: "urumi.ai/managed-by=provisioner",
    });
    expect(managed.map((n) => n.metadata.name).sort()).toEqual(["store-a", "store-b"]);
  });

  it("deletes with foreground propagation and treats already-gone as false", async () => {
    await client.apply(deployment("store-b", "web"));
    expect(await client.delete(deployment("store-b", "web"))).toBe(true);
    expect(kube.requests.at(-1)!.path).toMatch(/propagationPolicy=Foreground/);
    expect(await client.delete(deployment("store-b", "web"))).toBe(false);
  });

  it("deletes a namespace through a Terminating phase, taking its contents with it", async () => {
    await client.apply(ns("store-c"));
    await client.apply(deployment("store-c", "web"));
    await client.delete(ns("store-c"));
    const terminating = await client.get(ns("store-c"));
    expect(terminating?.metadata.deletionTimestamp).toBeTruthy();
    await expect(client.apply(deployment("store-c", "web2"))).rejects.toThrow(/terminated/);
    expect(await client.get(ns("store-c"))).toBeNull();
    expect(kube.get("deployments", "store-c", "web")).toBeUndefined();
  });

  it("tails pod logs, and reads a missing log as empty", async () => {
    kube.logs.set("store-a/job-x", "one\ntwo\nthree");
    expect(await client.podLogTail("store-a", "job-x", 2)).toBe("two\nthree");
    expect(await client.podLogTail("store-a", "job-y")).toBe("");
  });

  it("maps refusals to an error with the status and the API's message", async () => {
    kube.failNext(403, "namespaces is forbidden");
    const err = await client.apply(ns("x")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(K8sApiError);
    expect((err as K8sApiError).status).toBe(403);
    expect((err as Error).message).toMatch(
      /apply Namespace x \(HTTP 403\): namespaces is forbidden/,
    );
  });
});
