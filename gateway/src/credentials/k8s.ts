import { K8sClient, resourcePath } from "../k8s/client.js";
import type { CredentialStore, StoredCredential } from "./store.js";

export { K8sApiError } from "../k8s/client.js";

const SECRET_PREFIX = "mcp-upstream-";
const KEY = "credential";
const MANAGED_BY = "app.kubernetes.io/managed-by=mcp-gateway";

export interface K8sSecretStoreOptions {
  /** e.g. https://kubernetes.default.svc */
  apiUrl: string;
  /** The namespace that holds nothing but upstream credentials. */
  namespace: string;
  /** Called per request: projected service-account tokens rotate. */
  token?: () => Promise<string>;
  /** PEM of the API server's CA; omitted for plain-http fakes in tests. */
  ca?: string;
  timeoutMs?: number;
  /** Share an existing client instead of building one from the fields above. */
  client?: K8sClient;
}

/**
 * Upstream credentials as Kubernetes Secrets, via the plain REST API: four
 * verbs on one resource don't justify a client library. The gateway's
 * ServiceAccount is bound (by a Role in `namespace` only) to just these
 * verbs, so even a fully compromised gateway can read upstream credentials
 * and nothing else in the cluster - not the database password, not the
 * session secrets, not the other namespaces.
 */
export class K8sSecretStore implements CredentialStore {
  private readonly client: K8sClient;

  constructor(private readonly opts: K8sSecretStoreOptions) {
    this.client = opts.client ?? new K8sClient(opts);
  }

  /** Reads the in-cluster ServiceAccount token and CA; throws outside a pod. */
  static async inCluster(namespace: string): Promise<K8sSecretStore> {
    const client = await K8sClient.inCluster();
    return new K8sSecretStore({ apiUrl: "", namespace, client });
  }

  async get(serverId: string): Promise<StoredCredential | null> {
    const res = await this.call("GET", this.path(serverId));
    if (res.status === 404) return null;
    const secret = await this.json(res);
    const encoded = secret.data?.[KEY];
    if (typeof encoded !== "string") return null;
    return {
      value: Buffer.from(encoded, "base64").toString("utf8"),
      version: String(secret.metadata?.resourceVersion ?? ""),
    };
  }

  async put(serverId: string, value: string): Promise<void> {
    const body = {
      apiVersion: "v1",
      kind: "Secret",
      type: "Opaque",
      metadata: {
        name: this.name(serverId),
        labels: {
          "app.kubernetes.io/managed-by": "mcp-gateway",
          "urumi.ai/server-id": serverId,
        },
      },
      data: { [KEY]: Buffer.from(value, "utf8").toString("base64") },
    };
    const created = await this.call("POST", this.collection(), body);
    if (created.status === 201) return;
    if (created.status !== 409) await this.fail(created, "create");
    // Already exists: replace its value. No resourceVersion = unconditional.
    const replaced = await this.call("PUT", this.path(serverId), body);
    if (replaced.status !== 200) await this.fail(replaced, "replace");
  }

  async delete(serverId: string): Promise<void> {
    const res = await this.call("DELETE", this.path(serverId));
    if (res.status !== 200 && res.status !== 202 && res.status !== 404) {
      await this.fail(res, "delete");
    }
  }

  async list() {
    const res = await this.call(
      "GET",
      `${this.collection()}?labelSelector=${encodeURIComponent(MANAGED_BY)}`,
    );
    if (res.status !== 200) await this.fail(res, "list");
    const body = await this.json(res);
    return ((body.items ?? []) as { metadata: Record<string, unknown> }[]).flatMap((item) => {
      const name = String(item.metadata.name ?? "");
      if (!name.startsWith(SECRET_PREFIX)) return [];
      return [
        {
          serverId: name.slice(SECRET_PREFIX.length),
          createdAt: new Date(String(item.metadata.creationTimestamp ?? 0)),
        },
      ];
    });
  }

  private name(serverId: string) {
    if (!/^[0-9a-f-]{36}$/.test(serverId)) throw new Error("server id must be a UUID");
    return `${SECRET_PREFIX}${serverId}`;
  }
  private collection() {
    return resourcePath("v1", "Secret", this.opts.namespace);
  }
  private path(serverId: string) {
    return `${this.collection()}/${this.name(serverId)}`;
  }

  private call(method: string, path: string, body?: unknown) {
    return this.client.request(method, path, body);
  }

  private async json(res: Awaited<ReturnType<K8sClient["request"]>>) {
    return (await res.json()) as {
      data?: Record<string, unknown>;
      items?: unknown[];
      metadata?: Record<string, unknown>;
    };
  }

  private fail(res: Awaited<ReturnType<K8sClient["request"]>>, verb: string): Promise<never> {
    return this.client.fail(res, `${verb} secret`);
  }
}
