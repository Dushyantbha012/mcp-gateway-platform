import { randomBytes } from "node:crypto";
import type { K8sObject } from "../../k8s/client.js";
import type { StoreTemplate } from "../template.js";

/**
 * One store's Kubernetes objects, as pure data. Mirrors
 * helm/charts/store/templates/* (same images, ports, probes and security
 * contexts), plus what a namespace of its own needs: a ResourceQuota, a
 * LimitRange, Pod Security labels and a deny-by-default NetworkPolicy set
 * that keeps stores from reaching each other.
 *
 * Names are short ("mysql", "wordpress"): each store has its own namespace.
 */

export const MANAGED_BY_LABEL = "urumi.ai/managed-by";
export const MANAGED_BY_VALUE = "provisioner";
export const STORE_LABEL = "urumi.ai/store";

export const SECRET_NAMES = {
  db: "store-db",
  admin: "store-admin",
  wcApi: "store-wc-api",
  mcpAuth: "woocommerce-mcp-auth",
} as const;

export interface StoreSpec {
  slug: string;
  /** Shown as the site title. */
  name: string;
}

export interface BootstrapFiles {
  "bootstrap.sh": string;
  "set-admin.php": string;
  "register-api-key.php": string;
}

const DB_NAME = "wordpress";
const DB_USER = "wordpress";

export const storeNamespace = (slug: string) => `store-${slug}`;
export const storeHost = (slug: string, t: StoreTemplate) => `${slug}.${t.baseDomain}`;
export const storeUrl = (slug: string, t: StoreTemplate) =>
  `${t.tls ? "https" : "http"}://${storeHost(slug, t)}`;
/** What the gateway connects to; the provisioner registers it as the store's MCP server. */
export const storeMcpUrl = (slug: string, t: StoreTemplate) =>
  `http://woocommerce-mcp.${storeNamespace(slug)}.svc.cluster.local:${t.woocommerceMcp.port}/mcp`;

const labels = (slug: string, component?: string) => ({
  [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
  [STORE_LABEL]: slug,
  "app.kubernetes.io/instance": storeNamespace(slug),
  ...(component ? { "app.kubernetes.io/component": component } : {}),
});
const selector = (slug: string, component: string) => ({
  "app.kubernetes.io/instance": storeNamespace(slug),
  "app.kubernetes.io/component": component,
});

const meta = (slug: string, name: string, component?: string) => ({
  name,
  namespace: storeNamespace(slug),
  labels: labels(slug, component),
});

const podSecurity = (uid: number, fsGroup = true) => ({
  automountServiceAccountToken: false,
  securityContext: {
    runAsNonRoot: true,
    runAsUser: uid,
    runAsGroup: uid,
    ...(fsGroup ? { fsGroup: uid } : {}),
    seccompProfile: { type: "RuntimeDefault" },
  },
});
const containerSecurity = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ["ALL"] },
};
const secretEnv = (name: string, secret: string, key: string) => ({
  name,
  valueFrom: { secretKeyRef: { name: secret, key } },
});

function pvc(size: string, t: StoreTemplate) {
  return {
    accessModes: ["ReadWriteOnce"],
    ...(t.storageClassName ? { storageClassName: t.storageClassName } : {}),
    resources: { requests: { storage: size } },
  };
}

/** Env shared by WordPress and the bootstrap Job (see store.wordpressEnv in the chart). */
function wordpressEnv(slug: string, t: StoreTemplate) {
  const url = storeUrl(slug, t);
  const extra = [
    `define('WP_HOME', '${url}');`,
    `define('WP_SITEURL', '${url}');`,
    ...(t.tls
      ? [
          "if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') { $_SERVER['HTTPS'] = 'on'; }",
        ]
      : []),
  ].join("\n");
  return [
    { name: "WORDPRESS_DB_HOST", value: "mysql" },
    { name: "WORDPRESS_DB_NAME", value: DB_NAME },
    { name: "WORDPRESS_DB_USER", value: DB_USER },
    secretEnv("WORDPRESS_DB_PASSWORD", SECRET_NAMES.db, "password"),
    { name: "WORDPRESS_CONFIG_EXTRA", value: `${extra}\n` },
  ];
}

/** The namespace alone: applied first, everything else lives in it. */
export function storeNamespaceObject(spec: StoreSpec): K8sObject {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: storeNamespace(spec.slug),
      labels: {
        [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
        [STORE_LABEL]: spec.slug,
        // Every pod in a store already meets "restricted"; enforce it so a
        // future template change can't quietly loosen that.
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/enforce-version": "latest",
      },
    },
  };
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/**
 * Fresh random Secrets for a store. The reconciler only ever *creates* these
 * (409 = keep what's there): MySQL keeps the first password it was
 * initialised with, so a regenerated one would lock WordPress out.
 */
export function storeSecrets(spec: StoreSpec, t: StoreTemplate): K8sObject[] {
  const secret = (name: string, data: Record<string, string>): K8sObject => ({
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: meta(spec.slug, name),
    stringData: data,
  });
  return [
    secret(SECRET_NAMES.db, { "root-password": hex(24), password: hex(24) }),
    secret(SECRET_NAMES.admin, {
      username: "admin",
      password: hex(16),
      email: `admin@${storeHost(spec.slug, t)}`,
    }),
    // Same shape WooCommerce itself generates: ck_/cs_ + 40 hex chars.
    secret(SECRET_NAMES.wcApi, {
      "consumer-key": `ck_${hex(20)}`,
      "consumer-secret": `cs_${hex(20)}`,
    }),
    secret(SECRET_NAMES.mcpAuth, { token: hex(32) }),
  ];
}

function guardrails(spec: StoreSpec, t: StoreTemplate): K8sObject[] {
  const q = t.quota;
  return [
    {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: meta(spec.slug, "store-quota"),
      spec: {
        hard: {
          "requests.cpu": q.requestsCpu,
          "requests.memory": q.requestsMemory,
          "limits.cpu": q.limitsCpu,
          "limits.memory": q.limitsMemory,
          pods: String(q.pods),
          persistentvolumeclaims: String(q.pvcs),
          "requests.storage": q.storage,
          "services.loadbalancers": "0",
          "services.nodeports": "0",
        },
      },
    },
    {
      // With a quota on limits, a container without them would be refused;
      // this gives anything that forgets them small defaults instead.
      apiVersion: "v1",
      kind: "LimitRange",
      metadata: meta(spec.slug, "store-defaults"),
      spec: {
        limits: [
          {
            type: "Container",
            defaultRequest: { cpu: "50m", memory: "64Mi" },
            default: { cpu: "250m", memory: "256Mi" },
            max: { cpu: "1", memory: "1Gi" },
          },
        ],
      },
    },
  ];
}

function mysql(spec: StoreSpec, t: StoreTemplate): K8sObject[] {
  const { slug } = spec;
  const ping = [
    "sh",
    "-c",
    'mysqladmin ping -h 127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" --silent',
  ];
  return [
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: meta(slug, "mysql", "mysql"),
      spec: {
        clusterIP: "None",
        selector: selector(slug, "mysql"),
        ports: [{ name: "mysql", port: 3306, targetPort: "mysql" }],
      },
    },
    {
      apiVersion: "apps/v1",
      kind: "StatefulSet",
      metadata: meta(slug, "mysql", "mysql"),
      spec: {
        serviceName: "mysql",
        replicas: 1,
        selector: { matchLabels: selector(slug, "mysql") },
        template: {
          metadata: { labels: labels(slug, "mysql") },
          spec: {
            ...podSecurity(999),
            containers: [
              {
                name: "mysql",
                image: t.mysql.image,
                securityContext: containerSecurity,
                ports: [{ name: "mysql", containerPort: 3306 }],
                env: [
                  secretEnv("MYSQL_ROOT_PASSWORD", SECRET_NAMES.db, "root-password"),
                  { name: "MYSQL_DATABASE", value: DB_NAME },
                  { name: "MYSQL_USER", value: DB_USER },
                  secretEnv("MYSQL_PASSWORD", SECRET_NAMES.db, "password"),
                ],
                startupProbe: { exec: { command: ping }, periodSeconds: 5, failureThreshold: 60 },
                readinessProbe: { exec: { command: ping }, periodSeconds: 10, timeoutSeconds: 5 },
                livenessProbe: {
                  tcpSocket: { port: "mysql" },
                  periodSeconds: 20,
                  timeoutSeconds: 5,
                  failureThreshold: 6,
                },
                resources: t.mysql.resources,
                volumeMounts: [
                  { name: "data", mountPath: "/var/lib/mysql" },
                  { name: "run", mountPath: "/var/run/mysqld" },
                  { name: "tmp", mountPath: "/tmp" },
                ],
              },
            ],
            volumes: [
              { name: "run", emptyDir: {} },
              { name: "tmp", emptyDir: {} },
            ],
          },
        },
        volumeClaimTemplates: [{ metadata: { name: "data" }, spec: pvc(t.mysql.storage, t) }],
      },
    },
  ];
}

function wordpress(spec: StoreSpec, t: StoreTemplate): K8sObject[] {
  const { slug } = spec;
  const host = storeHost(slug, t);
  return [
    {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: meta(slug, "wordpress", "wordpress"),
      spec: pvc(t.wordpress.storage, t),
    },
    {
      // Apache on 8080 so it can run as non-root (see the chart).
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: meta(slug, "wordpress-apache", "wordpress"),
      data: {
        "ports.conf": "Listen 8080\n",
        "000-default.conf": [
          "<VirtualHost *:8080>",
          "    ServerAdmin webmaster@localhost",
          "    DocumentRoot /var/www/html",
          "    ErrorLog ${APACHE_LOG_DIR}/error.log",
          "    CustomLog ${APACHE_LOG_DIR}/access.log combined",
          "</VirtualHost>",
          "",
        ].join("\n"),
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: meta(slug, "wordpress", "wordpress"),
      spec: {
        type: "ClusterIP",
        selector: selector(slug, "wordpress"),
        ports: [{ name: "http", port: 80, targetPort: "http" }],
      },
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: meta(slug, "wordpress", "wordpress"),
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" }, // the volume is ReadWriteOnce
        selector: { matchLabels: selector(slug, "wordpress") },
        template: {
          metadata: { labels: labels(slug, "wordpress") },
          spec: {
            ...podSecurity(33),
            containers: [
              {
                name: "wordpress",
                image: t.wordpress.image,
                securityContext: containerSecurity,
                ports: [{ name: "http", containerPort: 8080 }],
                env: wordpressEnv(slug, t),
                startupProbe: {
                  tcpSocket: { port: "http" },
                  periodSeconds: 5,
                  failureThreshold: 60,
                },
                readinessProbe: {
                  httpGet: { path: "/wp-login.php", port: "http" },
                  periodSeconds: 10,
                  timeoutSeconds: 5,
                },
                livenessProbe: {
                  tcpSocket: { port: "http" },
                  periodSeconds: 20,
                  timeoutSeconds: 5,
                  failureThreshold: 6,
                },
                resources: t.wordpress.resources,
                volumeMounts: [
                  { name: "html", mountPath: "/var/www/html" },
                  {
                    name: "apache-conf",
                    mountPath: "/etc/apache2/ports.conf",
                    subPath: "ports.conf",
                    readOnly: true,
                  },
                  {
                    name: "apache-conf",
                    mountPath: "/etc/apache2/sites-enabled/000-default.conf",
                    subPath: "000-default.conf",
                    readOnly: true,
                  },
                  { name: "run", mountPath: "/var/run/apache2" },
                  { name: "lock", mountPath: "/var/lock/apache2" },
                  { name: "tmp", mountPath: "/tmp" },
                ],
              },
            ],
            volumes: [
              { name: "html", persistentVolumeClaim: { claimName: "wordpress" } },
              { name: "apache-conf", configMap: { name: "wordpress-apache" } },
              { name: "run", emptyDir: {} },
              { name: "lock", emptyDir: {} },
              { name: "tmp", emptyDir: {} },
            ],
          },
        },
      },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: {
        ...meta(slug, "wordpress", "wordpress"),
        ...(Object.keys(t.ingressAnnotations).length ? { annotations: t.ingressAnnotations } : {}),
      },
      spec: {
        ingressClassName: t.ingressClassName,
        ...(t.tls ? { tls: [{ hosts: [host], secretName: "wordpress-tls" }] } : {}),
        rules: [
          {
            host,
            http: {
              paths: [
                {
                  path: "/",
                  pathType: "Prefix",
                  backend: { service: { name: "wordpress", port: { name: "http" } } },
                },
              ],
            },
          },
        ],
      },
    },
  ];
}

export function bootstrapConfigMap(spec: StoreSpec, files: BootstrapFiles): K8sObject {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: meta(spec.slug, "bootstrap"),
    data: { ...files },
  };
}

/**
 * The install Job (WordPress core, WooCommerce, API key, sample products).
 * Job specs are immutable, so the reconciler creates it once rather than
 * applying it; a retry deletes the failed Job first.
 */
export function bootstrapJob(spec: StoreSpec, t: StoreTemplate): K8sObject {
  const { slug } = spec;
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: meta(slug, "bootstrap", "bootstrap"),
    spec: {
      backoffLimit: 3,
      activeDeadlineSeconds: t.bootstrap.timeoutSeconds,
      template: {
        metadata: { labels: labels(slug, "bootstrap") },
        spec: {
          restartPolicy: "Never",
          // The volume is ReadWriteOnce: run on WordPress's node.
          affinity: {
            podAffinity: {
              requiredDuringSchedulingIgnoredDuringExecution: [
                {
                  labelSelector: { matchLabels: selector(slug, "wordpress") },
                  topologyKey: "kubernetes.io/hostname",
                },
              ],
            },
          },
          ...podSecurity(33),
          containers: [
            {
              name: "wp-cli",
              image: t.bootstrap.image,
              securityContext: containerSecurity,
              command: ["sh", "/bootstrap/bootstrap.sh"],
              env: [
                ...wordpressEnv(slug, t),
                { name: "HOME", value: "/tmp" },
                { name: "WP_CLI_CACHE_DIR", value: "/tmp/wp-cli-cache" },
                { name: "SITE_URL", value: storeUrl(slug, t) },
                { name: "SITE_TITLE", value: spec.name },
                { name: "STORE_COUNTRY", value: t.site.country },
                { name: "STORE_CURRENCY", value: t.site.currency },
                { name: "WOOCOMMERCE_VERSION", value: t.bootstrap.woocommerceVersion },
                { name: "SEED_PRODUCTS", value: String(t.site.seedProducts) },
                secretEnv("ADMIN_USER", SECRET_NAMES.admin, "username"),
                secretEnv("ADMIN_PASSWORD", SECRET_NAMES.admin, "password"),
                secretEnv("ADMIN_EMAIL", SECRET_NAMES.admin, "email"),
                secretEnv("WC_CONSUMER_KEY", SECRET_NAMES.wcApi, "consumer-key"),
                secretEnv("WC_CONSUMER_SECRET", SECRET_NAMES.wcApi, "consumer-secret"),
              ],
              resources: t.bootstrap.resources,
              volumeMounts: [
                { name: "html", mountPath: "/var/www/html" },
                { name: "scripts", mountPath: "/bootstrap", readOnly: true },
                { name: "tmp", mountPath: "/tmp" },
              ],
            },
          ],
          volumes: [
            { name: "tmp", emptyDir: {} },
            { name: "html", persistentVolumeClaim: { claimName: "wordpress" } },
            { name: "scripts", configMap: { name: "bootstrap" } },
          ],
        },
      },
    },
  };
}

function woocommerceMcp(spec: StoreSpec, t: StoreTemplate): K8sObject[] {
  const { slug } = spec;
  const m = t.woocommerceMcp;
  return [
    {
      // ClusterIP only, no Ingress: reachable from inside the cluster, by the gateway.
      apiVersion: "v1",
      kind: "Service",
      metadata: meta(slug, "woocommerce-mcp", "woocommerce-mcp"),
      spec: {
        type: "ClusterIP",
        selector: selector(slug, "woocommerce-mcp"),
        ports: [{ name: "http", port: m.port, targetPort: "http" }],
      },
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: meta(slug, "woocommerce-mcp", "woocommerce-mcp"),
      spec: {
        replicas: 1,
        selector: { matchLabels: selector(slug, "woocommerce-mcp") },
        template: {
          metadata: { labels: labels(slug, "woocommerce-mcp") },
          spec: {
            ...podSecurity(1000, false),
            containers: [
              {
                name: "woocommerce-mcp",
                image: m.image,
                imagePullPolicy: m.imagePullPolicy,
                ports: [{ name: "http", containerPort: m.port }],
                env: [
                  { name: "PORT", value: String(m.port) },
                  {
                    name: "WC_BASE_URL",
                    value: `http://wordpress.${storeNamespace(slug)}.svc.cluster.local`,
                  },
                  // WooCommerce signs against its own (http) home URL; see the chart.
                  { name: "WC_SIGNING_URL", value: `http://${storeHost(slug, t)}` },
                  { name: "WC_TIMEOUT_MS", value: String(m.wcTimeoutMs) },
                  secretEnv("WC_CONSUMER_KEY", SECRET_NAMES.wcApi, "consumer-key"),
                  secretEnv("WC_CONSUMER_SECRET", SECRET_NAMES.wcApi, "consumer-secret"),
                  secretEnv("MCP_AUTH_TOKEN", SECRET_NAMES.mcpAuth, "token"),
                ],
                securityContext: containerSecurity,
                lifecycle: { preStop: { sleep: { seconds: 5 } } },
                readinessProbe: { httpGet: { path: "/readyz", port: "http" }, periodSeconds: 10 },
                livenessProbe: {
                  httpGet: { path: "/healthz", port: "http" },
                  periodSeconds: 20,
                  failureThreshold: 3,
                },
                resources: m.resources,
              },
            ],
          },
        },
      },
    },
  ];
}

/**
 * Deny everything, then allow exactly the store's own flows. Pod selectors
 * without a namespaceSelector only match pods in the store's namespace, so
 * nothing here lets one store reach another; the only cross-namespace
 * sources are the ingress controller (to WordPress) and the gateway (to MCP).
 */
function networkPolicies(spec: StoreSpec, t: StoreTemplate): K8sObject[] {
  const { slug } = spec;
  const np = (name: string, body: Record<string, unknown>): K8sObject => ({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: meta(slug, name),
    spec: body,
  });
  const pods = (component: string) => ({ podSelector: { matchLabels: selector(slug, component) } });
  const internet = t.internetEgress
    ? [
        {
          to: [{ ipBlock: { cidr: "0.0.0.0/0", except: t.privateRanges } }],
          ports: [
            { protocol: "TCP", port: 443 },
            { protocol: "TCP", port: 80 },
          ],
        },
      ]
    : [];
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
    np("mysql", {
      ...pods("mysql"),
      policyTypes: ["Ingress"],
      ingress: [{ from: [pods("wordpress"), pods("bootstrap")], ports: [{ port: 3306 }] }],
    }),
    np("wordpress", {
      ...pods("wordpress"),
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": t.ingressController.namespace },
              },
              podSelector: { matchLabels: t.ingressController.podLabels },
            },
            pods("woocommerce-mcp"),
          ],
          ports: [{ port: 8080 }],
        },
      ],
      egress: [{ to: [pods("mysql")], ports: [{ port: 3306 }] }],
    }),
    np("bootstrap", {
      ...pods("bootstrap"),
      policyTypes: ["Egress"],
      egress: [{ to: [pods("mysql")], ports: [{ port: 3306 }] }, ...internet],
    }),
    // cert-manager's HTTP-01 solver runs in the store's namespace while a
    // certificate is issued; without this the default-deny policy blocks the
    // ingress controller from reaching it and the certificate never issues.
    ...(t.tls
      ? [
          np("acme-solver", {
            podSelector: { matchLabels: { "acme.cert-manager.io/http01-solver": "true" } },
            policyTypes: ["Ingress"],
            ingress: [
              {
                from: [
                  {
                    namespaceSelector: {
                      matchLabels: { "kubernetes.io/metadata.name": t.ingressController.namespace },
                    },
                    podSelector: { matchLabels: t.ingressController.podLabels },
                  },
                ],
                ports: [{ port: 8089 }],
              },
            ],
          }),
        ]
      : []),
    np("woocommerce-mcp", {
      ...pods("woocommerce-mcp"),
      policyTypes: ["Ingress", "Egress"],
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
          ports: [{ port: t.woocommerceMcp.port }],
        },
      ],
      egress: [{ to: [pods("wordpress")], ports: [{ port: 8080 }] }],
    }),
  ];
}

/**
 * Everything the reconciler server-side-applies, in apply order. Secrets and
 * the bootstrap Job are separate (create-only; see above).
 */
export function storeManifests(
  spec: StoreSpec,
  t: StoreTemplate,
  files: BootstrapFiles,
): K8sObject[] {
  return [
    storeNamespaceObject(spec),
    ...guardrails(spec, t),
    ...networkPolicies(spec, t),
    ...mysql(spec, t),
    ...wordpress(spec, t),
    bootstrapConfigMap(spec, files),
    ...woocommerceMcp(spec, t),
  ];
}
