import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MemoryCredentialStore } from "../credentials/store.js";
import type { Store } from "../db/schema.js";
import { getServer } from "../db/servers.js";
import { createStore, getStore, transitionStore } from "../db/stores.js";
import { createUser } from "../db/users.js";
import { K8sClient } from "../k8s/client.js";
import { startFakeKubeApi, type FakeKubeApi } from "../test/fakeKubeApi.js";
import { createTestDatabase, hasTestDb, type TestDatabase } from "../test/testDb.js";
import { loadBootstrapFiles } from "./bootstrapFiles.js";
import { ProvisionerLoop } from "./loop.js";
import type { BootstrapFiles } from "./manifests/store.js";
import { StoreReconciler, type ReconcilerDeps } from "./reconciler.js";
import { parseStoreTemplate } from "./template.js";

describe.skipIf(!hasTestDb)("store reconciler", () => {
  let t: TestDatabase;
  let kube: FakeKubeApi;
  let files: BootstrapFiles;
  let owner: string;
  const credentials = new MemoryCredentialStore();
  const template = parseStoreTemplate("{}");
  let clock = new Date();

  beforeAll(async () => {
    t = await createTestDatabase();
    kube = await startFakeKubeApi();
    files = await loadBootstrapFiles();
    owner = (await createUser(t.db, { email: "o@x.io", name: "O", role: "member" })).id;
  });
  afterEach(async () => {
    await t.db.deleteFrom("stores").execute();
    await t.db.deleteFrom("mcp_servers").execute();
    kube.objects.clear();
    kube.objects.set("secrets", kube.secrets);
    kube.secrets.clear();
    clock = new Date();
  });
  afterAll(async () => {
    await kube?.close();
    await t?.drop();
  });

  const reconciler = (over: Partial<ReconcilerDeps> = {}) =>
    new StoreReconciler({
      db: t.db,
      kube: new K8sClient({ apiUrl: kube.url, token: async () => "test-token" }),
      credentials,
      template,
      files,
      timeoutMs: 15 * 60_000,
      now: () => clock,
      ...over,
    });

  async function newStore(slug: string): Promise<Store> {
    return (await createStore(t.db, { slug, name: slug.toUpperCase(), owner_id: owner }, 5)).store;
  }
  const reload = async (s: Store) => (await getStore(t.db, s.id))!;
  const pass = async (r: StoreReconciler, s: Store) => r.reconcile(await reload(s));

  /** Plays the part of the Kubernetes controllers for one store (for what exists so far). */
  const controllers = (slug: string) => {
    const ns = `store-${slug}`;
    const mark = (plural: string, name: string, status: Record<string, unknown>) => {
      if (kube.get(plural, ns, name)) kube.setStatus(plural, ns, name, status);
    };
    return {
      mysqlReady: () => mark("statefulsets", "mysql", { readyReplicas: 1 }),
      wordpressReady: () => mark("deployments", "wordpress", { readyReplicas: 1 }),
      mcpReady: () => mark("deployments", "woocommerce-mcp", { readyReplicas: 1 }),
      jobDone: () =>
        mark("jobs", "bootstrap", { conditions: [{ type: "Complete", status: "True" }] }),
      allReady() {
        this.mysqlReady();
        this.wordpressReady();
        this.jobDone();
        this.mcpReady();
      },
    };
  };

  it("walks a store through every step to ready and registers its MCP server", async () => {
    const r = reconciler();
    const store = await newStore("acme");
    const c = controllers("acme");

    expect(await pass(r, store)).toBe("waiting");
    expect(await reload(store)).toMatchObject({ step: "mysql", namespace: "store-acme" });
    expect(kube.get("namespaces", "", "store-acme")).toBeTruthy();
    expect(kube.get("resourcequotas", "store-acme", "store-quota")).toBeTruthy();
    expect(kube.get("networkpolicies", "store-acme", "default-deny-all")).toBeTruthy();
    expect(kube.get("jobs", "store-acme", "bootstrap")).toBeUndefined(); // not before WordPress

    c.mysqlReady();
    await pass(r, store);
    expect((await reload(store)).step).toBe("wordpress");

    c.wordpressReady();
    await pass(r, store);
    expect(await reload(store)).toMatchObject({
      step: "bootstrap",
      reason: "installing WordPress and WooCommerce",
    });
    expect(kube.get("jobs", "store-acme", "bootstrap")).toBeTruthy();

    c.jobDone();
    await pass(r, store);
    expect((await reload(store)).step).toBe("mcp");

    c.mcpReady();
    expect(await pass(r, store)).toBe("ready");
    const ready = await reload(store);
    expect(ready).toMatchObject({
      status: "ready",
      step: "ready",
      reason: null,
      url: "http://acme.store.local.test",
      server_id: store.id,
    });
    const server = await getServer(t.db, store.id);
    expect(server).toMatchObject({
      slug: "acme",
      managed_by: "store",
      auth_type: "bearer",
      url: "http://woocommerce-mcp.store-acme.svc.cluster.local:3000/mcp",
    });
    const token = Buffer.from(
      kube.get("secrets", "store-acme", "woocommerce-mcp-auth")!.data!.token,
      "base64",
    ).toString();
    expect((await credentials.get(store.id))?.value).toBe(token);
  });

  it("resumes after a crash without regenerating secrets or duplicating anything", async () => {
    const store = await newStore("acme");
    const c = controllers("acme");
    await pass(reconciler(), store);
    const firstPassword = kube.get("secrets", "store-acme", "store-db")!.data!.password;

    // A brand-new process (no memory of the first) carries on.
    c.allReady();
    // The Job doesn't exist yet: this pass creates it, then it "completes".
    await pass(reconciler(), store);
    c.jobDone();
    expect(await pass(reconciler(), store)).toBe("ready");
    expect(kube.get("secrets", "store-acme", "store-db")!.data!.password).toBe(firstPassword);

    // Even a pass on a store that is already registered is harmless.
    await transitionStore(t.db, store.id, ["ready"], { status: "provisioning" });
    expect(await pass(reconciler(), store)).toBe("ready");
    const servers = await t.db.selectFrom("mcp_servers").select("id").execute();
    expect(servers).toHaveLength(1);
  });

  it("fails with the Job's reason and last log line when the bootstrap fails", async () => {
    const r = reconciler();
    const store = await newStore("acme");
    const c = controllers("acme");
    await pass(r, store);
    c.mysqlReady();
    c.wordpressReady();
    await pass(r, store); // creates the Job
    kube.setStatus("jobs", "store-acme", "bootstrap", {
      conditions: [
        {
          type: "Failed",
          status: "True",
          reason: "BackoffLimitExceeded",
          message: "Job has reached the specified backoff limit",
        },
      ],
    });
    await new K8sClient({ apiUrl: kube.url, token: async () => "test-token" }).apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: "bootstrap-abc",
        namespace: "store-acme",
        labels: { "app.kubernetes.io/component": "bootstrap" },
      },
    });
    kube.logs.set(
      "store-acme/bootstrap-abc",
      "[bootstrap] installing\nError: could not download WooCommerce",
    );

    expect(await pass(r, store)).toBe("failed");
    const failed = await reload(store);
    expect(failed.status).toBe("failed");
    expect(failed.reason).toBe(
      "bootstrap failed: BackoffLimitExceeded - Job has reached the specified backoff limit; " +
        "last log line: Error: could not download WooCommerce",
    );
  });

  it("on retry, clears the failed Job and runs a fresh one", async () => {
    const r = reconciler();
    const store = await newStore("acme");
    await pass(r, store);
    controllers("acme").allReady();
    await pass(r, store); // creates the Job
    kube.setStatus("jobs", "store-acme", "bootstrap", {
      conditions: [{ type: "Failed", status: "True", reason: "DeadlineExceeded" }],
    });
    expect(await pass(r, store)).toBe("failed");

    await transitionStore(t.db, store.id, ["failed"], { status: "provisioning", step: "retry" });
    expect(await pass(r, store)).toBe("waiting"); // the Job is gone now
    expect(kube.get("jobs", "store-acme", "bootstrap")).toBeUndefined();
    await pass(r, store); // a fresh Job
    expect(kube.get("jobs", "store-acme", "bootstrap")?.status).toBeUndefined();
    controllers("acme").jobDone();
    expect(await pass(r, store)).toBe("ready");
  });

  it("explains a stuck pod, then times out naming the step and the condition", async () => {
    const r = reconciler();
    const store = await newStore("acme");
    await pass(r, store);
    await new K8sClient({ apiUrl: kube.url, token: async () => "test-token" }).apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: "mysql-0",
        namespace: "store-acme",
        labels: { "app.kubernetes.io/component": "mysql" },
      },
    });
    kube.setStatus("pods", "store-acme", "mysql-0", {
      containerStatuses: [
        { state: { waiting: { reason: "ImagePullBackOff", message: "Back-off pulling image" } } },
      ],
    });
    await pass(r, store);
    expect((await reload(store)).reason).toBe("mysql: ImagePullBackOff (Back-off pulling image)");

    clock = new Date(clock.getTime() + 16 * 60_000);
    expect(await pass(r, store)).toBe("failed");
    expect((await reload(store)).reason).toBe(
      "timed out at mysql: mysql: ImagePullBackOff (Back-off pulling image)",
    );
  });

  it("reports a quota refusal from the Deployment's conditions", async () => {
    const r = reconciler();
    const store = await newStore("acme");
    await pass(r, store);
    controllers("acme").mysqlReady();
    kube.setStatus("deployments", "store-acme", "wordpress", {
      conditions: [
        {
          type: "ReplicaFailure",
          status: "True",
          message: 'pods "wordpress-x" is forbidden: exceeded quota: store-quota',
        },
      ],
    });
    await pass(r, store);
    expect((await reload(store)).reason).toMatch(/^wordpress: .*exceeded quota/);
  });

  it("refuses to take over a namespace it didn't create", async () => {
    await new K8sClient({ apiUrl: kube.url, token: async () => "test-token" }).apply({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: "store-acme" },
    });
    const store = await newStore("acme");
    expect(await pass(reconciler(), store)).toBe("failed");
    expect((await reload(store)).reason).toMatch(/not managed by the provisioner/);
    expect(kube.get("resourcequotas", "store-acme", "store-quota")).toBeUndefined();
  });

  it("deletes the server, its credential and the namespace, then the row", async () => {
    const r = reconciler();
    const store = await newStore("acme");
    await pass(r, store);
    controllers("acme").allReady();
    await pass(r, store);
    controllers("acme").jobDone();
    expect(await pass(r, store)).toBe("ready");

    await transitionStore(t.db, store.id, ["ready"], { status: "deleting" });
    expect(await pass(r, store)).toBe("waiting");
    expect(await getServer(t.db, store.id)).toBeUndefined();
    expect(await credentials.get(store.id)).toBeNull();
    expect((await reload(store)).step).toBe("deleting-namespace");
    expect(kube.get("namespaces", "", "store-acme")?.metadata.deletionTimestamp).toBeTruthy();

    expect(await pass(r, store)).toBe("waiting"); // still Terminating (finalizers)
    expect(await pass(r, store)).toBe("deleted");
    expect(await getStore(t.db, store.id)).toBeUndefined();
    expect(kube.get("deployments", "store-acme", "wordpress")).toBeUndefined();
  });

  it("never lets a provisioning pass overwrite a delete that arrived meanwhile", async () => {
    const store = await newStore("acme");
    const stale = await reload(store); // what a pass started with
    await transitionStore(t.db, store.id, ["provisioning"], { status: "deleting" });
    await reconciler().reconcile(stale);
    expect((await reload(store)).status).toBe("deleting");
  });

  it("provisions several stores at once from the loop", async () => {
    const loop = new ProvisionerLoop(t.db, reconciler(), { tickMs: 60_000, concurrency: 3 });
    const stores = await Promise.all(["s-one", "s-two", "s-three"].map(newStore));
    loop.start();
    await loop.idle();
    for (const s of stores) {
      expect((await reload(s)).step).toBe("mysql");
      controllers(s.slug).allReady();
    }
    for (let i = 0; i < 2; i++) {
      loop.trigger();
      await loop.idle();
      for (const s of stores) controllers(s.slug).jobDone();
    }
    await loop.stop();
    for (const s of stores) expect((await reload(s)).status).toBe("ready");
  });
});
