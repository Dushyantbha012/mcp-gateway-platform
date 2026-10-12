import { readFile } from "node:fs/promises";
import { Agent, fetch as undiciFetch } from "undici";
import type { CredentialStore, StoredCredential } from "./store.js";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
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
}

/** A Kubernetes API call failed. The message never includes a Secret's contents. */
export class K8sApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "K8sApiError";
  }
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
  private readonly dispatcher?: Agent;
  private readonly token: () => Promise<string>;

  constructor(private readonly opts: K8sSecretStoreOptions) {
    this.dispatcher = opts.ca ? new Agent({ connect: { ca: opts.ca } }) : undefined;
    this.token = opts.token ?? (async () => (await readFile(`${SA_DIR}/token`, "utf8")).trim());
  }

  /** Reads the in-cluster ServiceAccount token and CA; throws outside a pod. */
  static async inCluster(namespace: string): Promise<K8sSecretStore> {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
    if (!host) throw new Error("not running in a Kubernetes pod (KUBERNETES_SERVICE_HOST unset)");
    return new K8sSecretStore({
      apiUrl: `https://${host.includes(":") ? `[${host}]` : host}:${port}`,
      namespace,
      ca: await readFile(`${SA_DIR}/ca.crt`, "utf8"),
    });
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
    return `/api/v1/namespaces/${encodeURIComponent(this.opts.namespace)}/secrets`;
  }
  private path(serverId: string) {
    return `${this.collection()}/${this.name(serverId)}`;
  }

  private async call(method: string, path: string, body?: unknown) {
    try {
      return await undiciFetch(new URL(path, this.opts.apiUrl), {
        method,
        headers: {
          authorization: `Bearer ${await this.token()}`,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5_000),
      });
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      throw new K8sApiError(0, `Kubernetes API unreachable (${cause ?? (err as Error).name})`);
    }
  }

  private async json(res: Awaited<ReturnType<typeof undiciFetch>>) {
    return (await res.json()) as {
      data?: Record<string, unknown>;
      items?: unknown[];
      metadata?: Record<string, unknown>;
    };
  }

  private async fail(res: Awaited<ReturnType<typeof undiciFetch>>, verb: string): Promise<never> {
    // Status + the API's own message ("secrets is forbidden: ..."), which names
    // resources but never contains secret data.
    let reason = "";
    try {
      reason = String(((await res.json()) as { message?: string }).message ?? "").slice(0, 200);
    } catch {
      /* not JSON */
    }
    throw new K8sApiError(
      res.status,
      `Kubernetes API refused to ${verb} secret (HTTP ${res.status}): ${reason}`,
    );
  }
}
