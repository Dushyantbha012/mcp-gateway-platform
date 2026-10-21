import { describe, expect, it } from "vitest";
import type { K8sObject } from "../../k8s/client.js";
import { parseStoreTemplate } from "../template.js";
import {
  bridgeAuthSecret,
  envChecksum,
  hostedManifests,
  hostedMcpUrl,
  type HostedSpec,
} from "./hosted.js";

const t = parseStoreTemplate("{}");
const stdio: HostedSpec = {
  id: "11111111-2222-3333-4444-555555555555",
  slug: "thinking",
  image: "mcp/sequentialthinking:0.6.2",
  transport: "stdio",
  command: ["node", "dist/index.js"],
  port: 8080,
  path: "/mcp",
  libc: "musl",
  env: { LOG_LEVEL: "info" },
  secretEnvKeys: [],
  authTokenEnv: null,
  egress: "none",
  size: "small",
};
const http: HostedSpec = {
  ...stdio,
  slug: "everything",
  image: "mcp/everything:2025.9.25",
  transport: "http",
  command: ["node", "dist/index.js", "streamableHttp"],
  port: 3001,
  secretEnvKeys: ["API_KEY"],
  authTokenEnv: "MCP_AUTH_TOKEN",
  egress: "internet",
  size: "medium",
};

type Pod = {
  automountServiceAccountToken?: boolean;
  securityContext: Record<string, unknown>;
  initContainers?: Container[];
  containers: Container[];
  volumes: { name: string }[];
};
type Container = {
  name: string;
  image: string;
  command?: string[];
  args?: string[];
  env?: { name: string; value?: string; valueFrom?: unknown }[];
  envFrom?: unknown[];
  securityContext: Record<string, unknown>;
  resources?: { limits?: Record<string, string> };
  ports?: { containerPort: number }[];
};
const byKind = (objs: K8sObject[], kind: string) => objs.filter((o) => o.kind === kind);
const deployment = (objs: K8sObject[]) => byKind(objs, "Deployment")[0]!;
const podOf = (objs: K8sObject[]) =>
  (deployment(objs) as unknown as { spec: { template: { spec: Pod } } }).spec.template.spec;

describe("hosted manifests", () => {
  for (const spec of [stdio, http]) {
    describe(spec.transport, () => {
      const objs = hostedManifests(spec, t, "abc");

      it("puts everything in mcp-<slug>, a restricted namespace the provisioner owns", () => {
        const [ns, ...rest] = objs;
        expect(ns).toMatchObject({
          kind: "Namespace",
          metadata: {
            name: `mcp-${spec.slug}`,
            labels: {
              "urumi.ai/managed-by": "provisioner",
              "pod-security.kubernetes.io/enforce": "restricted",
            },
          },
        });
        for (const o of rest) expect(o.metadata.namespace).toBe(`mcp-${spec.slug}`);
      });

      it("runs every container non-root, read-only, capability-free and with limits", () => {
        const pod = podOf(objs);
        expect(pod.automountServiceAccountToken).toBe(false);
        expect(pod.securityContext).toMatchObject({
          runAsNonRoot: true,
          runAsUser: 1000,
          seccompProfile: { type: "RuntimeDefault" },
        });
        for (const c of [...(pod.initContainers ?? []), ...pod.containers]) {
          expect(c.securityContext, c.name).toEqual({
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
          });
          expect(c.resources?.limits?.cpu, c.name).toBeTruthy();
          expect(c.resources?.limits?.memory, c.name).toBeTruthy();
        }
      });

      it("caps the namespace with a quota and no volumes or exposed services", () => {
        const quota = byKind(objs, "ResourceQuota")[0] as unknown as {
          spec: { hard: Record<string, string> };
        };
        expect(quota.spec.hard).toMatchObject({
          persistentvolumeclaims: "0",
          "services.loadbalancers": "0",
          "services.nodeports": "0",
        });
        const svc = byKind(objs, "Service")[0] as unknown as { spec: { type: string } };
        expect(svc.spec.type).toBe("ClusterIP");
        expect(byKind(objs, "Ingress")).toHaveLength(0);
      });

      it("denies all traffic but the gateway's, on the server's port", () => {
        const nps = byKind(objs, "NetworkPolicy") as unknown as {
          metadata: { name: string };
          spec: {
            podSelector: object;
            policyTypes: string[];
            ingress?: { from: unknown[]; ports: { port: number }[] }[];
            egress?: { to: { ipBlock?: { cidr: string; except: string[] } }[] }[];
          };
        }[];
        const deny = nps.find((n) => n.metadata.name === "default-deny-all")!;
        expect(deny.spec).toEqual({ podSelector: {}, policyTypes: ["Ingress", "Egress"] });
        const ingress = nps.flatMap((n) => n.spec.ingress ?? []);
        expect(ingress).toHaveLength(1);
        expect(ingress[0]!.from).toEqual([
          {
            namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "urumi" } },
            podSelector: { matchLabels: { "urumi.ai/mcp-client": "true" } },
          },
        ]);
        expect(ingress[0]!.ports).toEqual([
          { protocol: "TCP", port: spec.transport === "stdio" ? 8080 : spec.port },
        ]);
        const internet = nps.find((n) => n.metadata.name === "allow-internet-egress");
        if (spec.egress === "none") {
          expect(internet).toBeUndefined();
        } else {
          const block = internet!.spec.egress![0]!.to[0]!.ipBlock!;
          expect(block.cidr).toBe("0.0.0.0/0");
          expect(block.except).toEqual(expect.arrayContaining(["10.0.0.0/8", "169.254.0.0/16"]));
        }
      });
    });
  }

  it("stdio: an init container installs the bridge, which runs the server's command", () => {
    const pod = podOf(hostedManifests(stdio, t, ""));
    expect(pod.initContainers).toHaveLength(1);
    expect(pod.initContainers![0]).toMatchObject({
      image: "mcp-gateway/mcp-bridge:dev",
      args: ["musl", "/bridge"],
    });
    const server = pod.containers[0]!;
    expect(server.command).toEqual(["/bridge/mcp-bridge", "--", "node", "dist/index.js"]);
    expect(server.ports).toEqual([{ name: "http", containerPort: 8080 }]);
    expect(server.env).toEqual(
      expect.arrayContaining([
        { name: "HOME", value: "/tmp" },
        { name: "LOG_LEVEL", value: "info" },
        {
          name: "BRIDGE_AUTH_TOKEN",
          valueFrom: { secretKeyRef: { name: "bridge-auth", key: "token" } },
        },
      ]),
    );
    expect(server.envFrom).toBeUndefined();
    expect(hostedMcpUrl(stdio)).toBe("http://server.mcp-thinking.svc.cluster.local:8080/mcp");
  });

  it("http: runs the image's own server on its port, secret values from server-env", () => {
    const objs = hostedManifests(http, t, "abc");
    const pod = podOf(objs);
    expect(pod.initContainers).toBeUndefined();
    const server = pod.containers[0]!;
    expect(server.command).toEqual(["node", "dist/index.js", "streamableHttp"]);
    expect(server.env!.some((e) => e.name.startsWith("BRIDGE_"))).toBe(false);
    expect(server.envFrom).toEqual([{ secretRef: { name: "server-env" } }]);
    expect(server.env).toContainEqual({
      name: "MCP_AUTH_TOKEN",
      valueFrom: { secretKeyRef: { name: "bridge-auth", key: "token" } },
    });
    expect(deployment(objs)).toMatchObject({
      spec: { template: { metadata: { annotations: { "urumi.ai/env-checksum": "abc" } } } },
    });
    expect(hostedMcpUrl(http)).toBe("http://server.mcp-everything.svc.cluster.local:3001/mcp");
  });

  it("generates a fresh bridge token, and checksums env regardless of key order", () => {
    const a = bridgeAuthSecret(stdio) as unknown as { data: { token: string } };
    const b = bridgeAuthSecret(stdio) as unknown as { data: { token: string } };
    expect(Buffer.from(a.data.token, "base64").toString()).toMatch(/^[0-9a-f]{64}$/);
    expect(a.data.token).not.toBe(b.data.token);
    expect(envChecksum({ A: "1", B: "2" })).toBe(envChecksum({ B: "2", A: "1" }));
    expect(envChecksum({ A: "1" })).not.toBe(envChecksum({ A: "2" }));
  });
});
