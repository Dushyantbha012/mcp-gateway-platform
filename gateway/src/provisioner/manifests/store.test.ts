import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { beforeAll, describe, expect, it } from "vitest";
import type { K8sObject } from "../../k8s/client.js";
import { loadBootstrapFiles } from "../bootstrapFiles.js";
import { parseStoreTemplate } from "../template.js";
import {
  bootstrapJob,
  storeManifests,
  storeMcpUrl,
  storeSecrets,
  type BootstrapFiles,
} from "./store.js";

type Container = {
  name: string;
  image: string;
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  securityContext?: Record<string, unknown>;
  ports?: unknown[];
  env?: { name: string }[];
  volumeMounts?: unknown[];
  readinessProbe?: unknown;
  livenessProbe?: unknown;
  startupProbe?: unknown;
};
type PodSpec = {
  containers: Container[];
  securityContext?: Record<string, unknown>;
  automountServiceAccountToken?: boolean;
};
type PodTemplate = { metadata: { labels: Record<string, string> }; spec: PodSpec };

const t = parseStoreTemplate("{}");
const spec = { slug: "acme", name: "Acme Inc" };
let files: BootstrapFiles;
let all: K8sObject[];

beforeAll(async () => {
  files = await loadBootstrapFiles();
  all = [...storeManifests(spec, t, files), ...storeSecrets(spec, t), bootstrapJob(spec, t)];
});

const podTemplates = (objs: K8sObject[]) =>
  objs
    .filter((o) => ["Deployment", "StatefulSet", "Job"].includes(o.kind))
    .map((o) => ({ obj: o, tpl: (o.spec as { template: PodTemplate }).template }));

const policies = (objs: K8sObject[]) =>
  objs
    .filter((o) => o.kind === "NetworkPolicy")
    .map((o) => ({
      name: o.metadata.name,
      ...(o.spec as {
        podSelector: { matchLabels?: Record<string, string> };
        policyTypes: string[];
        ingress?: { from?: Record<string, unknown>[] }[];
        egress?: { to?: Record<string, unknown>[] }[];
      }),
    }));

const selects = (sel: { matchLabels?: Record<string, string> }, labels: Record<string, string>) =>
  Object.entries(sel.matchLabels ?? {}).every(([k, v]) => labels[k] === v);

/** "250m" -> 0.25, "1" -> 1; "384Mi" -> 384, "1Gi" -> 1024. */
const cpu = (v: string) => (v.endsWith("m") ? Number(v.slice(0, -1)) / 1000 : Number(v));
const mib = (v: string) =>
  v.endsWith("Gi") ? Number(v.slice(0, -2)) * 1024 : Number(v.slice(0, -2));

describe("store manifests", () => {
  it("put everything in the store's own namespace", () => {
    for (const o of all.filter((o) => o.kind !== "Namespace")) {
      expect(o.metadata.namespace, `${o.kind} ${o.metadata.name}`).toBe("store-acme");
    }
    const ns = all.find((o) => o.kind === "Namespace")!;
    expect(ns.metadata.name).toBe("store-acme");
    expect(ns.metadata.labels).toMatchObject({
      "urumi.ai/managed-by": "provisioner",
      "urumi.ai/store": "acme",
      "pod-security.kubernetes.io/enforce": "restricted",
    });
  });

  it("label every object as the provisioner's, so it never touches anything else", () => {
    for (const o of all) {
      expect(o.metadata.labels?.["urumi.ai/managed-by"], `${o.kind} ${o.metadata.name}`).toBe(
        "provisioner",
      );
    }
  });

  it("run every container non-root, read-only, without privileges, with limits", () => {
    const templates = podTemplates(all);
    expect(templates.map((p) => p.obj.metadata.name).sort()).toEqual([
      "bootstrap",
      "mysql",
      "woocommerce-mcp",
      "wordpress",
    ]);
    for (const { obj, tpl } of templates) {
      const pod = tpl.spec;
      expect(pod.automountServiceAccountToken, obj.metadata.name).toBe(false);
      expect(pod.securityContext).toMatchObject({
        runAsNonRoot: true,
        seccompProfile: { type: "RuntimeDefault" },
      });
      expect(pod.securityContext!.runAsUser).toBeGreaterThan(0);
      for (const c of pod.containers) {
        expect(c.securityContext, c.name).toEqual({
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ["ALL"] },
        });
        expect(c.resources?.limits?.cpu, c.name).toBeTruthy();
        expect(c.resources?.limits?.memory, c.name).toBeTruthy();
        expect(c.image, c.name).not.toMatch(/:latest$/);
      }
    }
  });

  it("fit the quota: the store's own requests and limits stay within it", () => {
    const containers = podTemplates(all).flatMap((p) => p.tpl.spec.containers);
    const sum = (f: (c: Container) => number) => containers.reduce((n, c) => n + f(c), 0);
    const quota = (
      all.find((o) => o.kind === "ResourceQuota")!.spec as {
        hard: Record<string, string>;
      }
    ).hard;
    expect(sum((c) => cpu(c.resources!.requests!.cpu))).toBeLessThanOrEqual(
      cpu(quota["requests.cpu"]),
    );
    expect(sum((c) => mib(c.resources!.requests!.memory))).toBeLessThanOrEqual(
      mib(quota["requests.memory"]),
    );
    expect(sum((c) => cpu(c.resources!.limits!.cpu))).toBeLessThanOrEqual(cpu(quota["limits.cpu"]));
    expect(sum((c) => mib(c.resources!.limits!.memory))).toBeLessThanOrEqual(
      mib(quota["limits.memory"]),
    );
    expect(mib(t.mysql.storage) + mib(t.wordpress.storage)).toBeLessThanOrEqual(
      mib(quota["requests.storage"]),
    );
    expect(quota["services.loadbalancers"]).toBe("0");
    expect(quota["services.nodeports"]).toBe("0");
  });

  it("deny all traffic by default, and give every pod a policy of its own", () => {
    const nps = policies(all);
    const deny = nps.find((p) => p.name === "default-deny-all")!;
    expect(deny.podSelector).toEqual({});
    expect(deny.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(deny.ingress).toBeUndefined();
    expect(deny.egress).toBeUndefined();
    for (const { obj, tpl } of podTemplates(all)) {
      const own = nps.filter(
        (p) =>
          Object.keys(p.podSelector.matchLabels ?? {}).length &&
          selects(p.podSelector, tpl.metadata.labels),
      );
      expect(own.length, obj.metadata.name).toBeGreaterThan(0);
    }
  });

  it("let traffic in from outside the namespace only via the ingress controller and the gateway", () => {
    const outside: string[] = [];
    for (const p of policies(all)) {
      for (const peer of [...(p.ingress ?? []).flatMap((r) => r.from ?? [])]) {
        if (peer.namespaceSelector || peer.ipBlock) {
          const ns = (peer.namespaceSelector as { matchLabels: Record<string, string> })
            .matchLabels["kubernetes.io/metadata.name"];
          // A namespaceSelector must be paired with a podSelector, or it'd admit the whole namespace.
          expect(peer.podSelector, `${p.name} from ${ns}`).toBeTruthy();
          outside.push(`${p.name}<-${ns}`);
        }
      }
    }
    expect(outside.sort()).toEqual(["woocommerce-mcp<-urumi", "wordpress<-kube-system"]);
    const mcp = policies(all).find((p) => p.name === "woocommerce-mcp")!;
    expect(mcp.ingress![0].from![0].podSelector).toEqual({
      matchLabels: { "urumi.ai/mcp-client": "true" },
    });
  });

  it("let traffic out of the namespace only to DNS, and the bootstrap Job to the public internet", () => {
    const outside: string[] = [];
    for (const p of policies(all)) {
      for (const peer of (p.egress ?? []).flatMap((r) => r.to ?? [])) {
        if (peer.ipBlock) {
          expect((peer.ipBlock as { except: string[] }).except).toEqual(t.privateRanges);
          outside.push(`${p.name}->internet`);
        } else if (peer.namespaceSelector) outside.push(`${p.name}->dns`);
      }
    }
    expect(outside.sort()).toEqual(["allow-dns-egress->dns", "bootstrap->internet"]);
  });

  it("serve the storefront at <slug>.<baseDomain> and register a namespaced MCP URL", () => {
    const ingress = all.find((o) => o.kind === "Ingress")!;
    expect((ingress.spec as { rules: { host: string }[] }).rules[0].host).toBe(
      "acme.store.local.test",
    );
    expect(storeMcpUrl("acme", t)).toBe(
      "http://woocommerce-mcp.store-acme.svc.cluster.local:3000/mcp",
    );
  });

  it("ship the chart's own bootstrap scripts", () => {
    const cm = all.find((o) => o.kind === "ConfigMap" && o.metadata.name === "bootstrap")!;
    expect(Object.keys(cm.data as object).sort()).toEqual([
      "bootstrap.sh",
      "register-api-key.php",
      "set-admin.php",
    ]);
    expect((cm.data as BootstrapFiles)["bootstrap.sh"]).toMatch(/Idempotent store bootstrap/);
  });

  it("generate fresh random secrets on each call (the reconciler only creates them once)", () => {
    const a = storeSecrets(spec, t);
    const b = storeSecrets(spec, t);
    const tokenOf = (s: K8sObject[]) =>
      (s.find((o) => o.metadata.name === "woocommerce-mcp-auth")!.stringData as { token: string })
        .token;
    expect(tokenOf(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenOf(a)).not.toBe(tokenOf(b));
    const wc = a.find((o) => o.metadata.name === "store-wc-api")!.stringData as Record<
      string,
      string
    >;
    expect(wc["consumer-key"]).toMatch(/^ck_[0-9a-f]{40}$/);
  });

  it("keep two stores fully apart", () => {
    const other = storeManifests({ slug: "globex", name: "Globex" }, t, files);
    expect(new Set(other.map((o) => o.metadata.namespace ?? o.metadata.name))).toEqual(
      new Set(["store-globex"]),
    );
  });

  it("honour TLS and ingress annotations from the template", () => {
    const tls = parseStoreTemplate(
      JSON.stringify({ tls: true, ingressAnnotations: { "cert-manager.io/cluster-issuer": "le" } }),
    );
    const ingress = storeManifests(spec, tls, files).find((o) => o.kind === "Ingress")!;
    expect(ingress.metadata.annotations).toEqual({ "cert-manager.io/cluster-issuer": "le" });
    expect((ingress.spec as { tls: unknown[] }).tls).toEqual([
      { hosts: ["acme.store.local.test"], secretName: "wordpress-tls" },
    ]);
  });

  it("reject a malformed template with a readable error", () => {
    expect(() => parseStoreTemplate('{"baseDomain":"Not A Domain"}')).toThrow(/baseDomain/);
  });
});

// Same images, ports, probes, mounts and security as the Helm chart's store,
// so a provisioned store behaves like the one `helm install` makes.
const hasHelm = (() => {
  try {
    execFileSync("helm", ["version", "--short"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasHelm)("parity with the Helm store chart", () => {
  let chart: Map<string, Container>;
  beforeAll(() => {
    const dir = fileURLToPath(new URL("../../../../helm/charts/store", import.meta.url));
    const out = execFileSync("helm", ["template", "platform", dir, "--namespace", "urumi"], {
      encoding: "utf8",
    });
    chart = new Map();
    for (const doc of yaml.loadAll(out) as K8sObject[]) {
      if (!doc || !["Deployment", "StatefulSet", "Job"].includes(doc.kind)) continue;
      for (const c of (doc.spec as { template: PodTemplate }).template.spec.containers) {
        chart.set(c.name, c);
      }
    }
  });

  it.each(["mysql", "wordpress", "wp-cli", "woocommerce-mcp"])("%s matches", (name) => {
    const ours = podTemplates(all)
      .flatMap((p) => p.tpl.spec.containers)
      .find((c) => c.name === name)!;
    const theirs = chart.get(name)!;
    expect(theirs, `chart has a ${name} container`).toBeTruthy();
    for (const field of [
      "image",
      "ports",
      "securityContext",
      "resources",
      "volumeMounts",
      "readinessProbe",
      "livenessProbe",
      "startupProbe",
    ] as const) {
      expect(ours[field], `${name}.${field}`).toEqual(theirs[field]);
    }
    expect(ours.env!.map((e) => e.name).sort()).toEqual(theirs.env!.map((e) => e.name).sort());
  });
});

describe.skipIf(!hasHelm)("the template Helm hands the provisioner", () => {
  it.each(["values-local.yaml", "values-prod.yaml"])("parses (%s)", (values) => {
    const dir = fileURLToPath(new URL("../../../../helm", import.meta.url));
    const out = execFileSync(
      "helm",
      [
        "template",
        "platform",
        dir,
        "-n",
        "urumi",
        "-f",
        `${dir}/values.yaml`,
        "-f",
        `${dir}/${values}`,
      ],
      { encoding: "utf8" },
    );
    const docs = (yaml.loadAll(out) as K8sObject[]).filter(Boolean);
    const provisioner = docs.find(
      (d) => d.kind === "Deployment" && d.metadata.name === "platform-gateway-provisioner",
    )!;
    const env = (provisioner.spec as { template: PodTemplate }).template.spec.containers[0]
      .env as unknown as { name: string; value?: string }[];
    const tpl = parseStoreTemplate(env.find((e) => e.name === "STORES_TEMPLATE")!.value);
    expect(tpl.gatewayNamespace).toBe("urumi");
    expect(tpl.mcpClientLabel).toBe("urumi.ai/mcp-client");
    expect(tpl.ingressController.namespace).toBe("kube-system");
    if (values === "values-local.yaml") expect(tpl.baseDomain).toBe("store.local.test");
    else expect(tpl).toMatchObject({ tls: true, baseDomain: "stores.change-me.example" });
    // The gateway may reach provisioned stores' MCP servers, and nothing may reach the provisioner.
    const policy = (name: string) =>
      docs.find((d) => d.kind === "NetworkPolicy" && d.metadata.name === name)!.spec as {
        ingress?: unknown[];
        egress: { to: { namespaceSelector?: { matchLabels: Record<string, string> } }[] }[];
      };
    expect(
      policy("gateway").egress.some(
        (r) => r.to[0].namespaceSelector?.matchLabels["urumi.ai/managed-by"] === "provisioner",
      ),
    ).toBe(true);
    if (values === "values-prod.yaml") expect(policy("provisioner").ingress).toEqual([]);
  });
});
