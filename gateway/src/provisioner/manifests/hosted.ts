import { createHash, randomBytes } from "node:crypto";
import type { K8sObject } from "../../k8s/client.js";
import type { StoreTemplate } from "../template.js";
import { MANAGED_BY_LABEL, MANAGED_BY_VALUE } from "./store.js";

/**
 * One hosted MCP server's Kubernetes objects, as pure data: a namespace of its
 * own (restricted Pod Security, a quota sized by preset), one Deployment and
 * a ClusterIP Service, and NetworkPolicies that let in the gateway and
 * nothing else, and let out DNS - plus the public internet if asked for.
 *
 * The image is untrusted code. It runs as UID 1000 with a read-only root
 * filesystem, no capabilities, no service-account token and a writable /tmp
 * only. stdio servers run under the bridge (copied in by an init container),
 * which serves them as Streamable HTTP behind a bearer token.
 */

export const HOSTED_LABEL = "urumi.ai/hosted";
/** The component label every hosted server pod carries; the gateway's egress policy selects it. */
export const HOSTED_COMPONENT = "hosted-mcp";
export const BRIDGE_PORT = 8080;
export const SECRET_NAMES = { bridgeAuth: "bridge-auth", env: "server-env" } as const;

/** Whether the gateway authenticates to this server with a generated bearer token. */
export const usesToken = (spec: Pick<HostedSpec, "transport" | "authTokenEnv">) =>
  spec.transport === "stdio" || spec.authTokenEnv !== null;

export interface HostedSpec {
  id: string;
  slug: string;
  image: string;
  transport: "http" | "stdio";
  command: string[];
  port: number;
  path: string;
  libc: "glibc" | "musl";
  env: Record<string, string>;
  secretEnvKeys: string[];
  /** http only: the variable that receives the gateway's bearer token. */
  authTokenEnv: string | null;
  egress: "none" | "internet";
  size: "small" | "medium";
}

const SIZES = {
  small: {
    container: {
      requests: { cpu: "50m", memory: "64Mi" },
      limits: { cpu: "500m", memory: "256Mi" },
    },
    // Room for two pods: a rolling update runs the new one beside the old.
    quota: { requestsCpu: "200m", requestsMemory: "256Mi", limitsCpu: "1", limitsMemory: "512Mi" },
  },
  medium: {
    container: {
      requests: { cpu: "100m", memory: "128Mi" },
      limits: { cpu: "1", memory: "512Mi" },
    },
    quota: { requestsCpu: "400m", requestsMemory: "512Mi", limitsCpu: "2", limitsMemory: "1Gi" },
  },
} as const;
// Copying the ~95 MB bridge binary fills the page cache, which counts against
// the container's memory: 32Mi gets it OOMKilled. (A pod's effective limit is
// the larger of this and the server's, so it costs no quota.)
const INIT_RESOURCES = {
  requests: { cpu: "10m", memory: "32Mi" },
  limits: { cpu: "200m", memory: "256Mi" },
};

export const hostedNamespace = (slug: string) => `mcp-${slug}`;
/** The port the Service and container listen on: the bridge's, or the image's own. */
export const hostedPort = (spec: Pick<HostedSpec, "transport" | "port">) =>
  spec.transport === "stdio" ? BRIDGE_PORT : spec.port;
/** What the gateway connects to; the provisioner registers it as the server's upstream. */
export const hostedMcpUrl = (spec: Pick<HostedSpec, "slug" | "transport" | "port" | "path">) =>
  `http://server.${hostedNamespace(spec.slug)}.svc.cluster.local:${hostedPort(spec)}${
    spec.transport === "stdio" ? "/mcp" : spec.path
  }`;

const labels = (slug: string, component?: string) => ({
  [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
  [HOSTED_LABEL]: slug,
  "app.kubernetes.io/instance": hostedNamespace(slug),
  ...(component ? { "app.kubernetes.io/component": component } : {}),
});
const selector = (slug: string) => ({
  "app.kubernetes.io/instance": hostedNamespace(slug),
  "app.kubernetes.io/component": HOSTED_COMPONENT,
});
const meta = (slug: string, name: string, component?: string) => ({
  name,
  namespace: hostedNamespace(slug),
  labels: labels(slug, component),
});

export function hostedNamespaceObject(spec: Pick<HostedSpec, "slug" | "id">): K8sObject {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: hostedNamespace(spec.slug),
      labels: {
        [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
        [HOSTED_LABEL]: spec.slug,
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/enforce-version": "latest",
      },
      annotations: { "urumi.ai/hosted-id": spec.id },
    },
  };
}

/**
 * The bearer token the gateway sends: the bridge's for stdio servers, or the
 * image's own (via authTokenEnv) for http ones. Created once, kept (the
 * gateway holds a copy).
 */
export function bridgeAuthSecret(spec: Pick<HostedSpec, "slug">): K8sObject {
  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: meta(spec.slug, SECRET_NAMES.bridgeAuth),
    data: { token: Buffer.from(randomBytes(32).toString("hex")).toString("base64") },
  };
}

/** The server's secret env values, copied from hosted-env-<id> (base64 `data`, as read). */
export function envSecret(spec: Pick<HostedSpec, "slug">, data: Record<string, string>): K8sObject {
  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: meta(spec.slug, SECRET_NAMES.env),
    data,
  };
}

/** Changes whenever the secret values do, so the pod restarts to pick them up. */
export const envChecksum = (data: Record<string, string>) =>
  createHash("sha256")
    .update(JSON.stringify(Object.entries(data).sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex")
    .slice(0, 16);

function guardrails(spec: HostedSpec): K8sObject[] {
  const q = SIZES[spec.size].quota;
  return [
    {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: meta(spec.slug, "hosted-quota"),
      spec: {
        hard: {
          "requests.cpu": q.requestsCpu,
          "requests.memory": q.requestsMemory,
          "limits.cpu": q.limitsCpu,
          "limits.memory": q.limitsMemory,
          pods: "3",
          persistentvolumeclaims: "0",
          "services.loadbalancers": "0",
          "services.nodeports": "0",
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "LimitRange",
      metadata: meta(spec.slug, "hosted-defaults"),
      spec: {
        limits: [
          {
            type: "Container",
            defaultRequest: { cpu: "50m", memory: "64Mi" },
            default: { cpu: "250m", memory: "256Mi" },
            max: { cpu: "1", memory: "512Mi" },
          },
        ],
      },
    },
  ];
}

function workload(spec: HostedSpec, t: StoreTemplate, checksum: string): K8sObject[] {
  const { slug } = spec;
  const port = hostedPort(spec);
  const stdio = spec.transport === "stdio";
  const env = [
    // Images often write caches under $HOME; the only writable place is /tmp.
    { name: "HOME", value: "/tmp" },
    ...Object.entries(spec.env)
      .filter(([k]) => k !== "HOME")
      .map(([name, value]) => ({ name, value })),
    ...(stdio
      ? [
          { name: "BRIDGE_PORT", value: String(BRIDGE_PORT) },
          {
            name: "BRIDGE_AUTH_TOKEN",
            valueFrom: { secretKeyRef: { name: SECRET_NAMES.bridgeAuth, key: "token" } },
          },
        ]
      : spec.authTokenEnv
        ? [
            {
              name: spec.authTokenEnv,
              valueFrom: { secretKeyRef: { name: SECRET_NAMES.bridgeAuth, key: "token" } },
            },
          ]
        : []),
  ];
  const volumes = [
    { name: "tmp", emptyDir: { sizeLimit: "256Mi" } },
    ...(stdio ? [{ name: "bridge", emptyDir: { sizeLimit: "128Mi" } }] : []),
  ];
  const securityContext = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  };
  const probes = stdio
    ? {
        // The bridge is ready once its child answered initialize.
        readinessProbe: { httpGet: { path: "/readyz", port: "http" }, periodSeconds: 5 },
        livenessProbe: {
          httpGet: { path: "/healthz", port: "http" },
          periodSeconds: 20,
          failureThreshold: 3,
        },
      }
    : // An arbitrary image has no known health path: an open port is the best signal.
      {
        readinessProbe: { tcpSocket: { port: "http" }, periodSeconds: 5 },
        livenessProbe: { tcpSocket: { port: "http" }, periodSeconds: 20, failureThreshold: 3 },
      };
  const command = stdio
    ? { command: ["/bridge/mcp-bridge", "--", ...spec.command] }
    : spec.command.length
      ? { command: spec.command }
      : {};

  return [
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: meta(slug, "server", HOSTED_COMPONENT),
      spec: {
        type: "ClusterIP",
        selector: selector(slug),
        ports: [{ name: "http", port, targetPort: "http" }],
      },
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: meta(slug, "server", HOSTED_COMPONENT),
      spec: {
        replicas: 1,
        selector: { matchLabels: selector(slug) },
        template: {
          metadata: {
            labels: labels(slug, HOSTED_COMPONENT),
            annotations: { "urumi.ai/env-checksum": checksum },
          },
          spec: {
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              fsGroup: 1000,
              seccompProfile: { type: "RuntimeDefault" },
            },
            ...(stdio
              ? {
                  initContainers: [
                    {
                      name: "install-bridge",
                      image: t.hosted.bridgeImage,
                      imagePullPolicy: t.hosted.bridgeImagePullPolicy,
                      args: [spec.libc, "/bridge"],
                      volumeMounts: [{ name: "bridge", mountPath: "/bridge" }],
                      securityContext,
                      resources: INIT_RESOURCES,
                    },
                  ],
                }
              : {}),
            containers: [
              {
                name: "server",
                image: spec.image,
                imagePullPolicy: t.hosted.imagePullPolicy,
                ...command,
                ports: [{ name: "http", containerPort: port }],
                env,
                ...(spec.secretEnvKeys.length
                  ? { envFrom: [{ secretRef: { name: SECRET_NAMES.env } }] }
                  : {}),
                volumeMounts: [
                  { name: "tmp", mountPath: "/tmp" },
                  ...(stdio ? [{ name: "bridge", mountPath: "/bridge", readOnly: true }] : []),
                ],
                securityContext,
                ...probes,
                resources: SIZES[spec.size].container,
              },
            ],
            volumes,
          },
        },
      },
    },
  ];
}

/**
 * Deny all; let the gateway's pods in on the server's port; let DNS out,
 * and with egress "internet" any public address - never the private ranges
 * (the cluster, its nodes, cloud metadata).
 */
function networkPolicies(spec: HostedSpec, t: StoreTemplate): K8sObject[] {
  // By component only (the namespace holds one workload): a network probe can
  // carry this label without matching the Deployment's selector, which would
  // have its ReplicaSet adopt - and then delete - the probe or the server.
  const serverPods = { matchLabels: { "app.kubernetes.io/component": HOSTED_COMPONENT } };
  const np = (name: string, body: Record<string, unknown>): K8sObject => ({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: meta(spec.slug, name),
    spec: body,
  });
  return [
    np("default-deny-all", { podSelector: {}, policyTypes: ["Ingress", "Egress"] }),
    np("allow-dns-egress", {
      podSelector: {},
      policyTypes: ["Egress"],
      egress: [
        {
          to: [
            {
              namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
              podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
            },
          ],
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
          ],
        },
      ],
    }),
    np("server", {
      podSelector: serverPods,
      policyTypes: ["Ingress"],
      ingress: [
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": t.gatewayNamespace },
              },
              podSelector: { matchLabels: { [t.mcpClientLabel]: "true" } },
            },
          ],
          ports: [{ protocol: "TCP", port: hostedPort(spec) }],
        },
      ],
    }),
    ...(spec.egress === "internet"
      ? [
          np("allow-internet-egress", {
            podSelector: serverPods,
            policyTypes: ["Egress"],
            egress: [{ to: [{ ipBlock: { cidr: "0.0.0.0/0", except: t.privateRanges } }] }],
          }),
        ]
      : []),
  ];
}

/** Everything the reconciler server-side-applies, in apply order (Secrets are separate). */
export function hostedManifests(spec: HostedSpec, t: StoreTemplate, checksum: string): K8sObject[] {
  return [
    hostedNamespaceObject(spec),
    ...guardrails(spec),
    ...networkPolicies(spec, t),
    ...workload(spec, t, checksum),
  ];
}
