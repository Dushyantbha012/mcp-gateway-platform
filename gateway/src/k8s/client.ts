import { readFile } from "node:fs/promises";
import { Agent, fetch as undiciFetch } from "undici";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
export const FIELD_MANAGER = "urumi-provisioner";

/** Any Kubernetes object, typed only as far as this code reads it. */
export interface K8sObject {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    resourceVersion?: string;
    creationTimestamp?: string;
    deletionTimestamp?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Enough to address one object: what `get` and `delete` take. */
export type K8sRef = Pick<K8sObject, "apiVersion" | "kind"> & {
  metadata: { name: string; namespace?: string };
};

export interface K8sClientOptions {
  /** e.g. https://kubernetes.default.svc */
  apiUrl: string;
  /** Called per request: projected service-account tokens rotate. */
  token?: () => Promise<string>;
  /** PEM of the API server's CA; omitted for plain-http fakes in tests. */
  ca?: string;
  timeoutMs?: number;
}

/** A Kubernetes API call failed. The message never includes an object's contents. */
export class K8sApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "K8sApiError";
  }
}

type Response = Awaited<ReturnType<typeof undiciFetch>>;

/**
 * kind -> REST plural and whether it lives in a namespace. Only the kinds the
 * gateway and provisioner actually touch; anything else is a programming error.
 */
const RESOURCES: Record<string, { plural: string; namespaced: boolean }> = {
  Namespace: { plural: "namespaces", namespaced: false },
  Secret: { plural: "secrets", namespaced: true },
  ConfigMap: { plural: "configmaps", namespaced: true },
  Service: { plural: "services", namespaced: true },
  ServiceAccount: { plural: "serviceaccounts", namespaced: true },
  PersistentVolumeClaim: { plural: "persistentvolumeclaims", namespaced: true },
  Pod: { plural: "pods", namespaced: true },
  ResourceQuota: { plural: "resourcequotas", namespaced: true },
  LimitRange: { plural: "limitranges", namespaced: true },
  Deployment: { plural: "deployments", namespaced: true },
  StatefulSet: { plural: "statefulsets", namespaced: true },
  Job: { plural: "jobs", namespaced: true },
  Ingress: { plural: "ingresses", namespaced: true },
  NetworkPolicy: { plural: "networkpolicies", namespaced: true },
};

/** The REST path of a collection (no name) or of one object. */
export function resourcePath(
  apiVersion: string,
  kind: string,
  namespace?: string,
  name?: string,
): string {
  const r = RESOURCES[kind];
  if (!r) throw new Error(`unsupported kind ${kind}`);
  const base = apiVersion.includes("/") ? `/apis/${apiVersion}` : `/api/${apiVersion}`;
  let path = base;
  if (r.namespaced) {
    if (!namespace) throw new Error(`${kind} needs a namespace`);
    path += `/namespaces/${encodeURIComponent(namespace)}`;
  }
  path += `/${r.plural}`;
  if (name !== undefined) path += `/${encodeURIComponent(name)}`;
  return path;
}

/**
 * The plain Kubernetes REST API: a handful of verbs on a handful of kinds
 * doesn't justify a client library. Callers get exactly the RBAC their
 * ServiceAccount is bound to - this class adds no privilege of its own.
 */
export class K8sClient {
  private readonly dispatcher?: Agent;
  private readonly token: () => Promise<string>;

  constructor(private readonly opts: K8sClientOptions) {
    this.dispatcher = opts.ca ? new Agent({ connect: { ca: opts.ca } }) : undefined;
    this.token = opts.token ?? (async () => (await readFile(`${SA_DIR}/token`, "utf8")).trim());
  }

  /** Reads the in-cluster ServiceAccount token and CA; throws outside a pod. */
  static async inCluster(timeoutMs?: number): Promise<K8sClient> {
    const host = process.env.KUBERNETES_SERVICE_HOST;
    const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
    if (!host) throw new Error("not running in a Kubernetes pod (KUBERNETES_SERVICE_HOST unset)");
    return new K8sClient({
      apiUrl: `https://${host.includes(":") ? `[${host}]` : host}:${port}`,
      ca: await readFile(`${SA_DIR}/ca.crt`, "utf8"),
      timeoutMs,
    });
  }

  /**
   * Server-side apply: creates the object or converges it to `obj`, owning
   * every field it sets. `force` takes fields over from other managers (e.g.
   * a human's kubectl edit) - the provisioner is the source of truth.
   */
  async apply<T extends K8sObject>(obj: T): Promise<T> {
    const path = resourcePath(obj.apiVersion, obj.kind, obj.metadata.namespace, obj.metadata.name);
    const res = await this.request(
      "PATCH",
      `${path}?fieldManager=${FIELD_MANAGER}&force=true`,
      obj,
      "application/apply-patch+yaml",
    );
    if (res.status !== 200 && res.status !== 201) await this.fail(res, `apply ${describe(obj)}`);
    return (await res.json()) as T;
  }

  /** The object, or null when it doesn't exist. */
  async get<T extends K8sObject = K8sObject>(ref: K8sRef): Promise<T | null> {
    const res = await this.request("GET", pathOf(ref));
    if (res.status === 404) return null;
    if (res.status !== 200) await this.fail(res, `get ${describe(ref)}`);
    return (await res.json()) as T;
  }

  /** Creates `obj`; false (not an error) when it already exists. */
  async create(obj: K8sObject): Promise<boolean> {
    const res = await this.request(
      "POST",
      resourcePath(obj.apiVersion, obj.kind, obj.metadata.namespace),
      obj,
    );
    if (res.status === 409) return false;
    if (res.status !== 201 && res.status !== 200) await this.fail(res, `create ${describe(obj)}`);
    return true;
  }

  /**
   * Deletes the object; false when it was already gone. Foreground
   * propagation: dependents (a Job's pods) go before the owner disappears.
   */
  async delete(ref: K8sRef): Promise<boolean> {
    const res = await this.request("DELETE", `${pathOf(ref)}?propagationPolicy=Foreground`);
    if (res.status === 404) return false;
    if (res.status !== 200 && res.status !== 202) await this.fail(res, `delete ${describe(ref)}`);
    return true;
  }

  /** Objects of one kind, optionally in one namespace and matching a label selector. */
  async list<T extends K8sObject = K8sObject>(
    apiVersion: string,
    kind: string,
    opts: { namespace?: string; labelSelector?: string } = {},
  ): Promise<T[]> {
    let path = resourcePath(apiVersion, kind, opts.namespace);
    if (opts.labelSelector) path += `?labelSelector=${encodeURIComponent(opts.labelSelector)}`;
    const res = await this.request("GET", path);
    if (res.status !== 200) await this.fail(res, `list ${kind}`);
    return (((await res.json()) as { items?: T[] }).items ?? []) as T[];
  }

  /** The last `lines` of a pod's log ("" when there is none yet). */
  async podLogTail(namespace: string, pod: string, lines = 5): Promise<string> {
    const res = await this.request(
      "GET",
      `${resourcePath("v1", "Pod", namespace, pod)}/log?tailLines=${lines}`,
    );
    if (res.status === 404 || res.status === 400) return "";
    if (res.status !== 200) await this.fail(res, `read log of pod ${pod}`);
    return (await res.text()).trim();
  }

  /** A raw call; for callers (the Secret store) with their own status handling. */
  async request(
    method: string,
    path: string,
    body?: unknown,
    contentType = "application/json",
  ): Promise<Response> {
    try {
      return await undiciFetch(new URL(path, this.opts.apiUrl), {
        method,
        headers: {
          authorization: `Bearer ${await this.token()}`,
          accept: "application/json",
          ...(body ? { "content-type": contentType } : {}),
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

  /**
   * Throws with the status and the API's own message ("secrets is forbidden:
   * ..."), which names resources but never contains their data.
   */
  async fail(res: Response, what: string): Promise<never> {
    let reason = "";
    try {
      reason = String(((await res.json()) as { message?: string }).message ?? "").slice(0, 200);
    } catch {
      /* not JSON */
    }
    throw new K8sApiError(
      res.status,
      `Kubernetes API refused to ${what} (HTTP ${res.status}): ${reason}`,
    );
  }
}

function pathOf(ref: K8sRef) {
  return resourcePath(ref.apiVersion, ref.kind, ref.metadata.namespace, ref.metadata.name);
}

function describe(ref: K8sRef) {
  const ns = ref.metadata.namespace ? `${ref.metadata.namespace}/` : "";
  return `${ref.kind} ${ns}${ref.metadata.name}`;
}
