import { z } from "zod";

/**
 * Everything about a provisioned store that isn't per-store: images, sizes,
 * quotas, network shape. Helm renders it as one JSON env var (STORES_TEMPLATE)
 * from the `stores:` values; every field has a default matching
 * helm/charts/store/values.yaml, so `{}` is a valid template.
 */
const resources = z.object({
  requests: z.object({ cpu: z.string(), memory: z.string() }),
  limits: z.object({ cpu: z.string(), memory: z.string() }),
});
const r = (cpu: string, memory: string, lcpu: string, lmemory: string) => ({
  requests: { cpu, memory },
  limits: { cpu: lcpu, memory: lmemory },
});

export const storeTemplateSchema = z.object({
  /** Stores are served at <slug>.<baseDomain>. */
  baseDomain: z
    .string()
    .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/)
    .default("store.local.test"),
  tls: z.boolean().default(false),
  ingressClassName: z.string().default("traefik"),
  /** e.g. cert-manager's cluster-issuer annotation, so each store gets its own certificate. */
  ingressAnnotations: z.record(z.string(), z.string()).default({}),
  storageClassName: z.string().default(""),
  /** Where the gateway runs, and the label its pods carry: the only MCP clients let in. */
  gatewayNamespace: z.string().default("urumi"),
  mcpClientLabel: z.string().default("urumi.ai/mcp-client"),
  ingressController: z
    .object({
      namespace: z.string().default("kube-system"),
      podLabels: z.record(z.string(), z.string()).default({ "app.kubernetes.io/name": "traefik" }),
    })
    .prefault({}),
  /** The bootstrap Job may reach the public internet on 80/443 except these. */
  internetEgress: z.boolean().default(true),
  privateRanges: z
    .array(z.string())
    .default(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10"]),
  site: z
    .object({
      country: z.string().default("US:CA"),
      currency: z.string().default("USD"),
      seedProducts: z.boolean().default(true),
    })
    .prefault({}),
  mysql: z
    .object({
      image: z.string().default("mysql:8.4.11"),
      storage: z.string().default("1Gi"),
      resources: resources.default(r("250m", "384Mi", "1", "1Gi")),
    })
    .prefault({}),
  wordpress: z
    .object({
      image: z.string().default("wordpress:7.1.3-php8.3-apache"),
      storage: z.string().default("1Gi"),
      resources: resources.default(r("200m", "256Mi", "1", "768Mi")),
    })
    .prefault({}),
  bootstrap: z
    .object({
      image: z.string().default("wordpress:cli-2.12.0-php8.3"),
      woocommerceVersion: z.string().default("11.2.1"),
      timeoutSeconds: z.number().int().positive().default(900),
      resources: resources.default(r("100m", "128Mi", "500m", "512Mi")),
    })
    .prefault({}),
  woocommerceMcp: z
    .object({
      image: z.string().default("mcp-gateway/woocommerce-mcp:dev"),
      imagePullPolicy: z.enum(["Always", "IfNotPresent", "Never"]).default("IfNotPresent"),
      port: z.number().int().default(3000),
      wcTimeoutMs: z.number().int().default(8000),
      resources: resources.default(r("50m", "64Mi", "500m", "256Mi")),
    })
    .prefault({}),
  /** Hosted MCP servers (they share the network shape and gateway labels above). */
  hosted: z
    .object({
      /** Ships the stdio bridge; an init container copies it into the server's pod. */
      bridgeImage: z.string().default("mcp-gateway/mcp-bridge:dev"),
      bridgeImagePullPolicy: z.enum(["Always", "IfNotPresent", "Never"]).default("IfNotPresent"),
      imagePullPolicy: z.enum(["Always", "IfNotPresent", "Never"]).default("IfNotPresent"),
    })
    .prefault({}),
  /**
   * Per-store ResourceQuota. Requests are capped tightly (what the scheduler
   * reserves on a laptop-sized node); limits more loosely, because the
   * store's own containers already add up to 3 CPU / 2.5Gi of limits.
   */
  quota: z
    .object({
      requestsCpu: z.string().default("1"),
      requestsMemory: z.string().default("1536Mi"),
      limitsCpu: z.string().default("3"),
      limitsMemory: z.string().default("3Gi"),
      pods: z.number().int().default(8),
      pvcs: z.number().int().default(2),
      storage: z.string().default("3Gi"),
    })
    .prefault({}),
});

export type StoreTemplate = z.infer<typeof storeTemplateSchema>;

export function parseStoreTemplate(json: string | undefined): StoreTemplate {
  const raw = json && json.trim() ? JSON.parse(json) : {};
  const parsed = storeTemplateSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid STORES_TEMPLATE: ${problems.join("; ")}`);
  }
  return parsed.data;
}
