import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A Secret as the fake API stores it (only the parts the tests look at). */
export type FakeSecret = {
  type?: string;
  metadata: {
    name: string;
    labels?: Record<string, string>;
    resourceVersion?: string;
    creationTimestamp?: string;
  };
  data?: Record<string, string>;
};

export interface FakeKubeApi {
  url: string;
  /** namespace -> name -> stored Secret object */
  secrets: Map<string, Map<string, FakeSecret>>;
  requests: { method: string; path: string; auth: string | undefined }[];
  /** Make the next request answer with this status (e.g. 403 from RBAC). */
  failNext(status: number, message?: string): void;
  close(): Promise<void>;
}

/**
 * The slice of the Kubernetes API the credential store uses: create / get /
 * replace / delete / list on Secrets in a namespace, bearer-token checked,
 * with the real API's status codes (409 on create-over-existing, 404 on
 * missing) and resourceVersion bumping on every write.
 */
export async function startFakeKubeApi(token = "test-token"): Promise<FakeKubeApi> {
  const secrets: FakeKubeApi["secrets"] = new Map();
  const requests: FakeKubeApi["requests"] = [];
  let version = 100;
  let failure: { status: number; message: string } | undefined;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      const method = req.method!;
      requests.push({ method, path: url.pathname + url.search, auth: req.headers.authorization });
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
      const m = /^\/api\/v1\/namespaces\/([^/]+)\/secrets(?:\/([^/]+))?$/.exec(url.pathname);
      if (!m) return send(404, { message: "not found" });
      const [, ns, name] = m;
      const bucket = secrets.get(ns) ?? new Map();
      secrets.set(ns, bucket);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      const stamp = (obj: FakeSecret, existing?: FakeSecret): FakeSecret => ({
        ...obj,
        metadata: {
          ...obj.metadata,
          namespace: ns,
          resourceVersion: String(++version),
          creationTimestamp: existing?.metadata.creationTimestamp ?? new Date().toISOString(),
        },
      });
      if (!name && method === "POST") {
        if (bucket.has(body.metadata.name)) return send(409, { message: "already exists" });
        bucket.set(body.metadata.name, stamp(body));
        return send(201, bucket.get(body.metadata.name));
      }
      if (!name && method === "GET") {
        return send(200, { items: [...bucket.values()] });
      }
      if (name && method === "GET") {
        return bucket.has(name) ? send(200, bucket.get(name)) : send(404, { message: "not found" });
      }
      if (name && method === "PUT") {
        if (!bucket.has(name)) return send(404, { message: "not found" });
        bucket.set(name, stamp(body, bucket.get(name)));
        return send(200, bucket.get(name));
      }
      if (name && method === "DELETE") {
        if (!bucket.delete(name)) return send(404, { message: "not found" });
        return send(200, { status: "Success" });
      }
      return send(405, { message: "method not allowed" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    secrets,
    requests,
    failNext: (status, message = "boom") => {
      failure = { status, message };
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
