import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { K8sHostedEnvStore } from "../credentials/hostedEnv.js";
import { MemoryCredentialStore } from "../credentials/store.js";
import { createHosted, getHosted, pendingHosted, transitionHosted } from "../db/hosted.js";
import type { HostedServer, NewHostedServer } from "../db/schema.js";
import { getServer } from "../db/servers.js";
import { K8sClient } from "../k8s/client.js";
import { startFakeKubeApi, type FakeKubeApi } from "../test/fakeKubeApi.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";
import { HostedReconciler } from "./hostedReconciler.js";
import { ProvisionerLoop } from "./loop.js";
import { parseStoreTemplate } from "./template.js";

const SECRETS_NS = "urumi-upstreams";

describe.skipIf(!hasTestDb)("hosted server reconciler", () => {
  let t: TestDatabase;
  let kube: FakeKubeApi;
  let client: K8sClient;
  let credentials: MemoryCredentialStore;
  let clock = new Date();

  beforeAll(async () => {
    t = await createTestDatabase();
    kube = await startFakeKubeApi();
    client = new K8sClient({ apiUrl: kube.url, token: async () => "test-token" });
  });
  afterEach(async () => {
    await t.db.deleteFrom("hosted_servers").execute();
    await t.db.deleteFrom("mcp_servers").execute();
    kube.objects.clear();
    kube.objects.set("secrets", kube.secrets);
    kube.secrets.clear();
    kube.logs.clear();
    clock = new Date();
  });
  afterAll(async () => {
    await kube?.close();
    await t?.drop();
  });

  const reconciler = () => {
    credentials = new MemoryCredentialStore();
    return new HostedReconciler({
      db: t.db,
      kube: client,
      credentials,
      template: parseStoreTemplate("{}"),
      secretsNamespace: SECRETS_NS,
      timeoutMs: 10 * 60_000,
      now: () => clock,
    });
  };

  async function newHosted(over: Partial<NewHostedServer> = {}): Promise<HostedServer> {
    return createHosted(t.db, {
      slug: "thinking",
      name: "Thinking",
      image: "mcp/sequentialthinking:0.6.2",
      transport: "stdio",
      command: ["node", "dist/index.js"],
      libc: "musl",
      env: JSON.stringify({}),
      ...over,
    });
  }
  const reload = async (h: HostedServer) => (await getHosted(t.db, h.id))!;
  const pass = async (r: HostedReconciler, h: HostedServer) => r.reconcile(await reload(h));
  const rolledOut = (ns: string) =>
    kube.setStatus("deployments", ns, "server", {
      replicas: 1,
      updatedReplicas: 1,
      readyReplicas: 1,
      availableReplicas: 1,
    });

  it("stdio: builds the namespace, waits for the server, registers it behind the bridge token", async () => {
    const r = reconciler();
    const h = await newHosted();

    expect(await pass(r, h)).toBe("waiting");
    expect(await reload(h)).toMatchObject({ step: "server", namespace: "mcp-thinking" });
    expect(kube.get("namespaces", "", "mcp-thinking")).toBeTruthy();
    expect(kube.get("networkpolicies", "mcp-thinking", "default-deny-all")).toBeTruthy();
    expect(kube.get("networkpolicies", "mcp-thinking", "allow-internet-egress")).toBeUndefined();
    const token = kube.get("secrets", "mcp-thinking", "bridge-auth")!.data!.token;

    // A second pass doesn't rotate the token the gateway will hold.
    await pass(r, h);
    expect(kube.get("secrets", "mcp-thinking", "bridge-auth")!.data!.token).toBe(token);

    rolledOut("mcp-thinking");
    expect(await pass(r, h)).toBe("ready");
    expect(await reload(h)).toMatchObject({ status: "ready", server_id: h.id, reason: null });
    expect(await getServer(t.db, h.id)).toMatchObject({
      slug: "thinking",
      managed_by: "hosted",
      auth_type: "bearer",
      has_credential: true,
      url: "http://server.mcp-thinking.svc.cluster.local:8080/mcp",
    });
    expect((await credentials.get(h.id))?.value).toBe(Buffer.from(token, "base64").toString());
  });

  it("copies secret env values into the namespace and restarts the pod when they change", async () => {
    const r = reconciler();
    const envStore = new K8sHostedEnvStore(client, SECRETS_NS);
    const h = await newHosted({
      slug: "everything",
      transport: "http",
      command: [],
      port: 3001,
      secret_env_keys: ["API_KEY"],
      egress: "internet",
    });
    await envStore.put(h.id, { API_KEY: "one" });

    await pass(r, h);
    const copied = kube.get("secrets", "mcp-everything", "server-env")!;
    expect(Buffer.from(copied.data!.API_KEY!, "base64").toString()).toBe("one");
    expect(kube.get("networkpolicies", "mcp-everything", "allow-internet-egress")).toBeTruthy();
    const checksum = () =>
      (
        kube.get("deployments", "mcp-everything", "server") as unknown as {
          spec: { template: { metadata: { annotations: Record<string, string> } } };
        }
      ).spec.template.metadata.annotations["urumi.ai/env-checksum"];
    const first = checksum();

    rolledOut("mcp-everything");
    expect(await pass(r, h)).toBe("ready");
    expect(await getServer(t.db, h.id)).toMatchObject({
      auth_type: "none",
      has_credential: false,
      url: "http://server.mcp-everything.svc.cluster.local:3001/mcp",
    });

    // An update: new value, egress cut off. The provisioner re-applies and drops the policy.
    await envStore.put(h.id, { API_KEY: "two" });
    await transitionHosted(t.db, h.id, ["ready"], { status: "provisioning", egress: "none" });
    // The old pod is still ready, but the new spec hasn't rolled out: not ready yet.
    kube.setStatus("deployments", "mcp-everything", "server", {
      replicas: 2,
      updatedReplicas: 1,
      readyReplicas: 1,
      availableReplicas: 1,
    });
    expect(await pass(r, h)).toBe("waiting");
    expect(checksum()).not.toBe(first);
    expect(kube.get("networkpolicies", "mcp-everything", "allow-internet-egress")).toBeUndefined();
    rolledOut("mcp-everything");
    expect(await pass(r, h)).toBe("ready");
  });

  it("http with authTokenEnv: generates the token and registers bearer auth", async () => {
    const r = reconciler();
    const h = await newHosted({
      slug: "woo",
      transport: "http",
      command: [],
      port: 3000,
      auth_token_env: "MCP_AUTH_TOKEN",
    });
    await pass(r, h);
    const token = kube.get("secrets", "mcp-woo", "bridge-auth")!.data!.token;
    rolledOut("mcp-woo");
    expect(await pass(r, h)).toBe("ready");
    expect(await getServer(t.db, h.id)).toMatchObject({
      auth_type: "bearer",
      has_credential: true,
    });
    expect((await credentials.get(h.id))?.value).toBe(Buffer.from(token, "base64").toString());
  });

  it("fails with a missing secret value instead of starting without it", async () => {
    const r = reconciler();
    const h = await newHosted({ secret_env_keys: ["API_KEY"] });
    expect(await pass(r, h)).toBe("failed");
    expect((await reload(h)).reason).toMatch(/API_KEY are missing/);
  });

  it("reports ImagePullBackOff and CrashLoopBackOff, and fails at the deadline", async () => {
    const r = reconciler();
    const h = await newHosted();
    await pass(r, h);
    const pod = (status: Record<string, unknown>) => {
      kube.objects.get("pods")?.clear();
      const pods = new Map([
        [
          "server-abc",
          {
            metadata: {
              name: "server-abc",
              namespace: "mcp-thinking",
              labels: { "app.kubernetes.io/component": "hosted-mcp" },
            },
            status,
          },
        ],
      ]);
      kube.objects.set("pods", new Map([["mcp-thinking", pods]]));
    };

    pod({
      containerStatuses: [
        { state: { waiting: { reason: "ImagePullBackOff", message: "Back-off pulling image" } } },
      ],
    });
    await pass(r, h);
    expect((await reload(h)).reason).toBe("hosted-mcp: ImagePullBackOff (Back-off pulling image)");

    pod({
      containerStatuses: [
        {
          state: { waiting: { reason: "CrashLoopBackOff" } },
          lastState: { terminated: { exitCode: 1, reason: "Error" } },
        },
      ],
    });
    kube.logs.set("mcp-thinking/server-abc", "starting\nError: EACCES: permission denied");
    await pass(r, h);
    expect((await reload(h)).reason).toBe(
      "hosted-mcp: CrashLoopBackOff, exit code 1; last log line: Error: EACCES: permission denied",
    );

    pod({
      initContainerStatuses: [
        {
          name: "install-bridge",
          state: { terminated: { exitCode: 137, reason: "OOMKilled" } },
        },
      ],
      containerStatuses: [{ name: "server", state: { waiting: { reason: "PodInitializing" } } }],
    });
    await pass(r, h);
    expect((await reload(h)).reason).toBe(
      "hosted-mcp (init container install-bridge): OOMKilled, exit code 137",
    );

    clock = new Date(Date.now() + 11 * 60_000);
    expect(await pass(r, h)).toBe("failed");
    expect(await reload(h)).toMatchObject({
      status: "failed",
      reason: expect.stringMatching(/^timed out at server: hosted-mcp \(init container/),
    });
  });

  it("refuses to adopt a namespace it didn't create", async () => {
    const r = reconciler();
    await client.apply({ apiVersion: "v1", kind: "Namespace", metadata: { name: "mcp-thinking" } });
    const h = await newHosted();
    expect(await pass(r, h)).toBe("failed");
    expect((await reload(h)).reason).toMatch(/not managed by the provisioner/);
  });

  it("deletes: tools first, then the namespace, the stored secret values and the row", async () => {
    const r = reconciler();
    const envStore = new K8sHostedEnvStore(client, SECRETS_NS);
    const h = await newHosted({ secret_env_keys: ["K"] });
    await envStore.put(h.id, { K: "v" });
    await pass(r, h);
    rolledOut("mcp-thinking");
    await pass(r, h);
    expect(await getServer(t.db, h.id)).toBeTruthy();

    await transitionHosted(t.db, h.id, ["ready"], { status: "deleting" });
    expect(await pass(r, h)).toBe("waiting");
    expect(await getServer(t.db, h.id)).toBeUndefined();
    expect(await credentials.get(h.id)).toBeNull();
    expect(await reload(h)).toMatchObject({ step: "deleting-namespace" });

    let outcome = await pass(r, h);
    for (let i = 0; outcome !== "deleted" && i < 5; i++) outcome = await pass(r, h);
    expect(outcome).toBe("deleted");
    expect(kube.get("namespaces", "", "mcp-thinking")).toBeUndefined();
    expect(await envStore.get(h.id)).toBeNull();
    expect(await getHosted(t.db, h.id)).toBeUndefined();
  });

  it("runs in the provisioner loop", async () => {
    const r = reconciler();
    const h = await newHosted();
    const loop = new ProvisionerLoop(t.db, r, {
      tickMs: 60_000,
      concurrency: 2,
      pending: pendingHosted,
    });
    loop.start();
    await loop.idle();
    await loop.stop();
    expect((await reload(h)).step).toBe("server");
  });
});
