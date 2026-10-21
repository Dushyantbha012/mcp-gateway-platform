import { K8sClient, resourcePath } from "../k8s/client.js";

const SECRET_PREFIX = "hosted-env-";

/** The Secret holding a hosted server's secret environment values. */
export const hostedEnvSecretName = (hostedId: string) => {
  if (!/^[0-9a-f-]{36}$/.test(hostedId)) throw new Error("hosted server id must be a UUID");
  return `${SECRET_PREFIX}${hostedId}`;
};

/**
 * Secret environment values of hosted servers (API keys the server itself
 * needs). Like upstream credentials they never touch Postgres: the gateway
 * writes them next to the credentials, and the provisioner copies them into
 * the server's own namespace.
 */
export interface HostedEnvStore {
  get(hostedId: string): Promise<Record<string, string> | null>;
  /** Creates or replaces the whole set. */
  put(hostedId: string, values: Record<string, string>): Promise<void>;
  /** Deleting something that doesn't exist is not an error. */
  delete(hostedId: string): Promise<void>;
}

export class MemoryHostedEnvStore implements HostedEnvStore {
  readonly entries = new Map<string, Record<string, string>>();

  async get(hostedId: string) {
    const e = this.entries.get(hostedId);
    return e ? { ...e } : null;
  }
  async put(hostedId: string, values: Record<string, string>) {
    this.entries.set(hostedId, { ...values });
  }
  async delete(hostedId: string) {
    this.entries.delete(hostedId);
  }
}

/** One Secret per hosted server, each value under its variable's name. */
export class K8sHostedEnvStore implements HostedEnvStore {
  constructor(
    private readonly client: K8sClient,
    private readonly namespace: string,
  ) {}

  async get(hostedId: string) {
    const res = await this.client.request("GET", this.path(hostedId));
    if (res.status === 404) return null;
    if (res.status !== 200) await this.client.fail(res, "get secret");
    const data = ((await res.json()) as { data?: Record<string, string> }).data ?? {};
    return Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, Buffer.from(v, "base64").toString("utf8")]),
    );
  }

  async put(hostedId: string, values: Record<string, string>) {
    const body = {
      apiVersion: "v1",
      kind: "Secret",
      type: "Opaque",
      metadata: {
        name: hostedEnvSecretName(hostedId),
        labels: {
          "app.kubernetes.io/managed-by": "mcp-gateway",
          "urumi.ai/hosted-id": hostedId,
        },
      },
      data: Object.fromEntries(
        Object.entries(values).map(([k, v]) => [k, Buffer.from(v, "utf8").toString("base64")]),
      ),
    };
    const created = await this.client.request("POST", this.collection(), body);
    if (created.status === 201) return;
    if (created.status !== 409) await this.client.fail(created, "create secret");
    const replaced = await this.client.request("PUT", this.path(hostedId), body);
    if (replaced.status !== 200) await this.client.fail(replaced, "replace secret");
  }

  async delete(hostedId: string) {
    const res = await this.client.request("DELETE", this.path(hostedId));
    if (res.status !== 200 && res.status !== 202 && res.status !== 404) {
      await this.client.fail(res, "delete secret");
    }
  }

  private collection() {
    return resourcePath("v1", "Secret", this.namespace);
  }
  private path(hostedId: string) {
    return `${this.collection()}/${hostedEnvSecretName(hostedId)}`;
  }
}
