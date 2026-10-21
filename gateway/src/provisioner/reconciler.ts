import { sql } from "kysely";
import type { CredentialStore } from "../credentials/store.js";
import type { Db } from "../db/db.js";
import { deleteRulesForServer } from "../db/permissions.js";
import type { Store } from "../db/schema.js";
import { deleteStoreRow, transitionStore, updateStore } from "../db/stores.js";
import type { K8sClient, K8sObject } from "../k8s/client.js";
import { log } from "../logger.js";
import { guardNamespace, ProvisionFailure, Waiting, workloadReady, type Step } from "./checks.js";
import {
  bootstrapJob,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  SECRET_NAMES,
  storeManifests,
  storeMcpUrl,
  storeNamespace,
  storeNamespaceObject,
  storeSecrets,
  storeUrl,
  type BootstrapFiles,
} from "./manifests/store.js";
import type { StoreTemplate } from "./template.js";

export interface ReconcilerDeps {
  db: Db;
  kube: K8sClient;
  credentials: CredentialStore;
  template: StoreTemplate;
  files: BootstrapFiles;
  /** Provisioning budget for a store whose row has no deadline yet. */
  timeoutMs: number;
  onOutcome?: (kind: "provision" | "delete", outcome: ReconcileOutcome) => void;
  now?: () => Date;
}

export type ReconcileOutcome = "progress" | "waiting" | "ready" | "failed" | "deleted";

/** A store failed for good (until the user retries). */
export const StoreFailure = ProvisionFailure;

/**
 * Turns `stores` rows into running stores and back. Holds no state between
 * calls: every pass re-derives where a store is from the cluster and the
 * row, and every step is a no-op when already done - so a provisioner that
 * crashes mid-way just picks the store up again on its next pass.
 */
export class StoreReconciler {
  private readonly now: () => Date;

  constructor(private readonly deps: ReconcilerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** One pass over one store. Never throws: failures are recorded on the row. */
  async reconcile(store: Store): Promise<ReconcileOutcome> {
    if (store.kind !== "provisioned") return "waiting";
    const kind = store.status === "deleting" ? "delete" : "provision";
    let outcome: ReconcileOutcome;
    try {
      if (store.status === "deleting") outcome = await this.teardown(store);
      else if (store.status === "provisioning") outcome = await this.provision(store);
      else return "waiting";
    } catch (err) {
      const reason =
        err instanceof ProvisionFailure
          ? err.message
          : `unexpected error: ${(err as Error).message}`;
      log("warn", "store reconcile failed", { store: store.slug, kind, reason });
      if (kind === "provision") {
        await transitionStore(this.deps.db, store.id, ["provisioning"], {
          status: "failed",
          reason: reason.slice(0, 500),
        });
        outcome = "failed";
      } else {
        // Leave it in `deleting` and try again next pass, but say why it's stuck.
        if (store.reason !== reason.slice(0, 500)) {
          await updateStore(this.deps.db, store.id, { reason: reason.slice(0, 500) });
        }
        outcome = "waiting";
      }
    }
    this.deps.onOutcome?.(kind, outcome);
    return outcome;
  }

  private spec(store: Store) {
    return { slug: store.slug, name: store.name };
  }

  private async provision(store: Store): Promise<ReconcileOutcome> {
    const { kube, template: t, files } = this.deps;
    const spec = this.spec(store);
    const ns = storeNamespace(store.slug);
    const deadline = store.deadline_at ?? new Date(this.now().getTime() + this.deps.timeoutMs);
    if (!store.deadline_at) {
      await updateStore(this.deps.db, store.id, { deadline_at: deadline, namespace: ns });
    }

    // A retry: the failed Job is immutable, so remove it and let the
    // bootstrap step create a fresh one (the script picks up where it stopped).
    if (store.step === "retry") {
      const job = await kube.get(bootstrapJob(spec, t));
      if (job) {
        if (!job.metadata.deletionTimestamp) await kube.delete(job);
        const reason = "removing the failed bootstrap Job";
        if (store.reason !== reason) {
          store.reason = reason;
          await transitionStore(this.deps.db, store.id, ["provisioning"], { reason });
        }
        return "waiting";
      }
    }

    const steps: Step[] = [
      {
        name: "namespace",
        run: async () => {
          const waiting = await guardNamespace(kube, ns);
          if (waiting) return waiting;
          await kube.apply(storeNamespaceObject(spec));
        },
      },
      {
        name: "secrets",
        // Create-only: an existing Secret is kept (MySQL already uses its password).
        run: async () => {
          for (const secret of storeSecrets(spec, t)) await kube.create(secret);
        },
      },
      {
        name: "resources",
        run: async () => {
          for (const obj of storeManifests(spec, t, files).slice(1)) await kube.apply(obj);
        },
      },
      { name: "mysql", run: () => workloadReady(kube, ns, "StatefulSet", "mysql") },
      { name: "wordpress", run: () => workloadReady(kube, ns, "Deployment", "wordpress") },
      { name: "bootstrap", run: () => this.bootstrapDone(store) },
      { name: "mcp", run: () => workloadReady(kube, ns, "Deployment", "woocommerce-mcp") },
      { name: "register", run: () => this.register(store) },
    ];

    for (const step of steps) {
      const result = await step.run();
      if (result instanceof Waiting) {
        if (this.now() > deadline) {
          throw new ProvisionFailure(`timed out at ${step.name}: ${result.condition}`);
        }
        await this.recordProgress(store, step.name, result.condition);
        return "waiting";
      }
    }

    const ready = await transitionStore(this.deps.db, store.id, ["provisioning"], {
      status: "ready",
      step: "ready",
      reason: null,
      url: storeUrl(store.slug, t),
      server_id: store.id,
    });
    if (ready) log("info", "store ready", { store: store.slug });
    return ready ? "ready" : "progress";
  }

  /** Where provisioning is waiting, and on what - written only when it changes. */
  private async recordProgress(store: Store, step: string, condition: string) {
    const reason = condition.slice(0, 500);
    if (store.step === step && store.reason === reason) return;
    store.step = step;
    store.reason = reason;
    await transitionStore(this.deps.db, store.id, ["provisioning"], { step, reason });
  }

  /** The bootstrap Job: created once, then watched until it completes or fails. */
  private async bootstrapDone(store: Store): Promise<Waiting | void> {
    const { kube, template: t } = this.deps;
    const job = bootstrapJob(this.spec(store), t);
    const existing = await kube.get(job);
    if (!existing) {
      await kube.create(job);
      return new Waiting("installing WordPress and WooCommerce");
    }
    const conditions = (
      (existing.status as { conditions?: JobCondition[] } | undefined)?.conditions ?? []
    ).filter((c) => c.status === "True");
    if (conditions.some((c) => c.type === "Complete")) return;
    const failed = conditions.find((c) => c.type === "Failed");
    if (failed) {
      const tail = await this.jobLogTail(job.metadata.namespace!);
      throw new ProvisionFailure(
        `bootstrap failed: ${failed.reason ?? "Failed"}${failed.message ? ` - ${failed.message}` : ""}` +
          (tail ? `; last log line: ${tail}` : ""),
      );
    }
    return new Waiting("installing WordPress and WooCommerce");
  }

  private async jobLogTail(ns: string): Promise<string> {
    const pods = await this.deps.kube.list("v1", "Pod", {
      namespace: ns,
      labelSelector: "app.kubernetes.io/component=bootstrap",
    });
    const newest = pods.sort((a, b) =>
      String(b.metadata.creationTimestamp).localeCompare(String(a.metadata.creationTimestamp)),
    )[0];
    if (!newest) return "";
    const text = await this.deps.kube.podLogTail(ns, newest.metadata.name, 1);
    return text.split("\n").at(-1)?.slice(0, 200) ?? "";
  }

  /**
   * Makes the store's MCP server one of the gateway's upstreams. The server
   * row reuses the store's id, so a retry after a crash finds (and converges)
   * the row it already wrote instead of adding a second one. Credential
   * first, row second - the same order as the admin API.
   */
  private async register(store: Store): Promise<void> {
    const { db, kube, credentials, template: t } = this.deps;
    const secret = await kube.get<K8sObject & { data?: Record<string, string> }>({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: SECRET_NAMES.mcpAuth, namespace: storeNamespace(store.slug) },
    });
    const encoded = secret?.data?.token;
    if (!encoded) throw new ProvisionFailure("the store's MCP token Secret is missing");
    await credentials.put(store.id, Buffer.from(encoded, "base64").toString("utf8"));
    const taken = await db
      .selectFrom("mcp_servers")
      .select(["id"])
      .where("slug", "=", store.slug)
      .where("id", "!=", store.id)
      .executeTakeFirst();
    if (taken) throw new ProvisionFailure(`an MCP server named '${store.slug}' already exists`);
    await db
      .insertInto("mcp_servers")
      .values({
        id: store.id,
        slug: store.slug,
        name: store.name,
        url: storeMcpUrl(store.slug, t),
        auth_type: "bearer",
        has_credential: true,
        managed_by: "store",
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          url: storeMcpUrl(store.slug, t),
          has_credential: true,
          updated_at: sql<Date>`now()`,
        }),
      )
      .execute();
  }

  /**
   * Gateway side first (so the tools disappear at once), then the namespace -
   * which takes the PVCs, Secrets and everything else with it - then the row.
   */
  private async teardown(store: Store): Promise<ReconcileOutcome> {
    const { db, kube, credentials } = this.deps;
    const removed = await db
      .deleteFrom("mcp_servers")
      .where("id", "=", store.id)
      .where("managed_by", "=", "store")
      .executeTakeFirst();
    if (removed.numDeletedRows > 0n) await deleteRulesForServer(db, store.slug);
    await credentials.delete(store.id);

    const name = storeNamespace(store.slug);
    const ref = { apiVersion: "v1", kind: "Namespace", metadata: { name } };
    const ns = await kube.get(ref);
    if (ns) {
      if (ns.metadata.labels?.[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE) {
        throw new ProvisionFailure(
          `refusing to delete namespace ${name}: not managed by the provisioner`,
        );
      }
      if (!ns.metadata.deletionTimestamp) await kube.delete(ref);
      if (store.step !== "deleting-namespace") {
        await updateStore(db, store.id, { step: "deleting-namespace", reason: null });
      }
      return "waiting";
    }
    await deleteStoreRow(db, store.id);
    log("info", "store deleted", { store: store.slug });
    return "deleted";
  }
}

type JobCondition = { type: string; status: string; reason?: string; message?: string };
