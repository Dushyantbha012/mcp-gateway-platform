import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** An object as the fake API stores it (only the parts the tests look at). */
export type FakeObject = {
  apiVersion?: string;
  kind?: string;
  type?: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    resourceVersion?: string;
    creationTimestamp?: string;
    deletionTimestamp?: string;
    [key: string]: unknown;
  };
  data?: Record<string, string>;
  status?: Record<string, unknown>;
  [key: string]: unknown;
};
export type FakeSecret = FakeObject;

export interface FakeRequest {
  method: string;
  path: string;
  auth: string | undefined;
  contentType: string | undefined;
}

export interface FakeKubeApi {
  url: string;
  /** namespace -> name -> stored Secret object (a view of `objects`). */
  secrets: Map<string, Map<string, FakeSecret>>;
  /** REST plural ("deployments") -> namespace ("" if cluster-scoped) -> name -> object */
  objects: Map<string, Map<string, Map<string, FakeObject>>>;
  requests: FakeRequest[];
  /** Make the next request answer with this status (e.g. 403 from RBAC). */
  failNext(status: number, message?: string): void;
  /** One stored object, or undefined. */
  get(plural: string, namespace: string, name: string): FakeObject | undefined;
  /** Replace an object's status, as a controller would (e.g. a Deployment becoming ready). */
  setStatus(plural: string, namespace: string, name: string, status: Record<string, unknown>): void;
  /** Canned pod logs: namespace/pod -> text. */
  logs: Map<string, string>;
  /**
   * How many GETs a deleted namespace still answers (Terminating) before it
   * is gone - like the real API while finalizers run. Default 1.
   */
  terminatingReads: number;
  close(): Promise<void>;
}

type Parsed = { plural: string; namespace: string; name?: string; sub?: string };

/** /api/v1/namespaces/x/secrets/y, /apis/apps/v1/namespaces/x/deployments, /api/v1/namespaces/x ... */
function parse(pathname: string): Parsed | null {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  let rest: string[];
  if (parts[0] === "api" && parts[1] === "v1") rest = parts.slice(2);
  else if (parts[0] === "apis" && parts.length >= 3) rest = parts.slice(3);
  else return null;
  // namespaces/{ns}/{plural}[/{name}[/{sub}]]
  if (rest[0] === "namespaces" && rest.length >= 3) {
    return { namespace: rest[1], plural: rest[2], name: rest[3], sub: rest[4] };
  }
  // cluster-scoped: {plural}[/{name}]
  if (rest.length >= 1 && rest.length <= 2)
    return { namespace: "", plural: rest[0], name: rest[1] };
  return null;
}

function matches(labels: Record<string, string> | undefined, selector: string | null) {
  if (!selector) return true;
  return selector.split(",").every((term) => {
    const [k, v] = term.split("=");
    return labels?.[k] === v;
  });
}

/**
 * The slice of the Kubernetes API the gateway and provisioner use: create /
 * get / replace / server-side-apply / delete / list on any kind, bearer-token
 * checked, with the real API's status codes (409 on create-over-existing, 404
 * on missing), resourceVersion bumping on every write, statuses that survive
 * apply, and namespace deletion that cascades after a Terminating phase.
 */
export async function startFakeKubeApi(token = "test-token"): Promise<FakeKubeApi> {
  const objects: FakeKubeApi["objects"] = new Map();
  const requests: FakeRequest[] = [];
  const logs = new Map<string, string>();
  let version = 100;
  let failure: { status: number; message: string } | undefined;
  const terminating = new Map<string, number>();

  const bucket = (plural: string, ns: string) => {
    let byNs = objects.get(plural);
    if (!byNs) objects.set(plural, (byNs = new Map()));
    let names = byNs.get(ns);
    if (!names) byNs.set(ns, (names = new Map()));
    return names;
  };
  bucket("secrets", ""); // so `secrets` below is a live view
  const secrets = objects.get("secrets")!;

  const api: FakeKubeApi = {
    url: "",
    secrets,
    objects,
    requests,
    logs,
    terminatingReads: 1,
    failNext: (status, message = "boom") => {
      failure = { status, message };
    },
    get: (plural, ns, name) => objects.get(plural)?.get(ns)?.get(name),
    setStatus: (plural, ns, name, status) => {
      const obj = objects.get(plural)?.get(ns)?.get(name);
      if (!obj) throw new Error(`no ${plural} ${ns}/${name}`);
      obj.status = status;
      obj.metadata.resourceVersion = String(++version);
    },
    close: () => new Promise((r) => server.close(() => r())),
  };

  const removeNamespace = (ns: string) => {
    bucket("namespaces", "").delete(ns);
    for (const byNs of objects.values()) byNs.get(ns)?.clear();
    terminating.delete(ns);
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      const method = req.method!;
      requests.push({
        method,
        path: url.pathname + url.search,
        auth: req.headers.authorization,
        contentType: req.headers["content-type"],
      });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${token}`) {
        return send(401, { message: "Unauthorized" });
      }
      if (failure) {
        const f = failure;
        failure = undefined;
        return send(f.status, { message: f.message });
      }
      const p = parse(url.pathname);
      if (!p) return send(404, { message: "not found" });
      const { plural, namespace: ns, name, sub } = p;
      const store = bucket(plural, ns);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      const stamp = (obj: FakeObject, existing?: FakeObject): FakeObject => ({
        ...obj,
        ...(existing?.status && !obj.status ? { status: existing.status } : {}),
        metadata: {
          ...obj.metadata,
          ...(ns ? { namespace: ns } : {}),
          resourceVersion: String(++version),
          creationTimestamp: existing?.metadata.creationTimestamp ?? new Date().toISOString(),
        },
      });
      const nsGone = ns && plural !== "namespaces" && terminating.has(ns);

      if (sub === "log" && plural === "pods" && method === "GET") {
        const text = logs.get(`${ns}/${name}`);
        if (text === undefined) return send(404, { message: "not found" });
        const tail = Number(url.searchParams.get("tailLines") ?? 0);
        const lines = text.split("\n");
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end((tail ? lines.slice(-tail) : lines).join("\n"));
      }
      if (sub) return send(404, { message: "not found" });

      if (!name && method === "POST") {
        if (nsGone) return send(403, { message: `namespace ${ns} is being terminated` });
        if (store.has(body.metadata.name)) return send(409, { message: "already exists" });
        store.set(body.metadata.name, stamp(body));
        return send(201, store.get(body.metadata.name));
      }
      if (!name && method === "GET") {
        const selector = url.searchParams.get("labelSelector");
        return send(200, {
          items: [...store.values()].filter((o) => matches(o.metadata.labels, selector)),
        });
      }
      if (name && method === "GET") {
        const found = store.get(name);
        if (!found) return send(404, { message: "not found" });
        if (plural === "namespaces" && terminating.has(name)) {
          const left = terminating.get(name)!;
          if (left <= 0) {
            removeNamespace(name);
            return send(404, { message: "not found" });
          }
          terminating.set(name, left - 1);
        }
        return send(200, found);
      }
      if (name && method === "PUT") {
        if (!store.has(name)) return send(404, { message: "not found" });
        store.set(name, stamp(body, store.get(name)));
        return send(200, store.get(name));
      }
      if (name && method === "PATCH") {
        if (!String(req.headers["content-type"]).startsWith("application/apply-patch")) {
          return send(415, { message: "only server-side apply is faked" });
        }
        if (url.searchParams.get("fieldManager") === null) {
          return send(422, { message: "fieldManager is required for apply" });
        }
        if (nsGone) return send(403, { message: `namespace ${ns} is being terminated` });
        if (body?.metadata?.name !== name) return send(400, { message: "name mismatch" });
        const existing = store.get(name);
        store.set(name, stamp(body, existing));
        return send(existing ? 200 : 201, store.get(name));
      }
      if (name && method === "DELETE") {
        const found = store.get(name);
        if (!found) return send(404, { message: "not found" });
        if (plural === "namespaces") {
          if (!terminating.has(name)) {
            terminating.set(name, api.terminatingReads);
            found.metadata.deletionTimestamp = new Date().toISOString();
            found.status = { phase: "Terminating" };
          }
          return send(202, found);
        }
        store.delete(name);
        return send(200, { status: "Success" });
      }
      return send(405, { message: "method not allowed" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  api.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return api;
}
