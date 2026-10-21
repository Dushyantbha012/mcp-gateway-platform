import { sql } from "kysely";
import type { CredentialStore } from "../credentials/store.js";
import { hostedEnvSecretName } from "../credentials/hostedEnv.js";
import type { Db } from "../db/db.js";
import { deleteHostedRow, transitionHosted, updateHosted } from "../db/hosted.js";
import { deleteRulesForServer } from "../db/permissions.js";
import type { HostedServer } from "../db/schema.js";
import type { K8sClient, K8sObject } from "../k8s/client.js";
import { log } from "../logger.js";
import { guardNamespace, ProvisionFailure, Waiting, workloadReady, type Step } from "./checks.js";
import {
  bridgeAuthSecret,
  envChecksum,
  envSecret,
  HOSTED_COMPONENT,
  hostedManifests,
  hostedMcpUrl,
  hostedNamespace,
  SECRET_NAMES,
  usesToken,
  type HostedSpec,
} from "./manifests/hosted.js";
import { MANAGED_BY_LABEL, MANAGED_BY_VALUE } from "./manifests/store.js";
import type { ReconcileOutcome } from "./reconciler.js";
import type { StoreTemplate } from "./template.js";

export interface HostedReconcilerDeps {
  db: Db;
  kube: K8sClient;
  credentials: CredentialStore;
  template: StoreTemplate;
  /** Where the gateway keeps hosted-env-<id> (the upstream-secrets namespace). */
  secretsNamespace: string;
  /** Budget for a server whose row has no deadline yet. */
  timeoutMs: number;
  onOutcome?: (kind: "provision" | "delete", outcome: ReconcileOutcome) => void;
  now?: () => Date;
}

type SecretObject = K8sObject & { data?: Record<string, string> };

export function hostedSpec(h: HostedServer): HostedSpec {
  return {
    id: h.id,
    slug: h.slug,
    image: h.image,
    transport: h.transport,
    command: h.command,
    port: h.port,
    path: h.path,
    libc: h.libc,
    env: h.env,
    secretEnvKeys: h.secret_env_keys,
    authTokenEnv: h.auth_token_env,
    egress: h.egress,
    size: h.size,
  };
}

/**
 * Turns `hosted_servers` rows into running MCP servers and back, the same
 * way StoreReconciler does stores: stateless, every step idempotent, so a
 * pass interrupted anywhere is simply redone. An update re-runs the same
 * steps; "ready" then also means the new spec has fully rolled out.
 */
export class HostedReconciler {
  private readonly now: () => Date;

  constructor(private readonly deps: HostedReconcilerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** One pass over one server. Never throws: failures are recorded on the row. */
  async reconcile(hosted: HostedServer): Promise<ReconcileOutcome> {
    const kind = hosted.status === "deleting" ? "delete" : "provision";
    let outcome: ReconcileOutcome;
    try {
      if (hosted.status === "deleting") outcome = await this.teardown(hosted);
      else if (hosted.status === "provisioning") outcome = await this.provision(hosted);
      else return "waiting";
    } catch (err) {
      const reason = (
        err instanceof ProvisionFailure
          ? err.message
          : `unexpected error: ${(err as Error).message}`
      ).slice(0, 500);
      log("warn", "hosted reconcile failed", { hosted: hosted.slug, kind, reason });
      if (kind === "provision") {
        await transitionHosted(this.deps.db, hosted.id, ["provisioning"], {
          status: "failed",
          reason,
        });
        outcome = "failed";
      } else {
        if (hosted.reason !== reason) await updateHosted(this.deps.db, hosted.id, { reason });
        outcome = "waiting";
      }
    }
    this.deps.onOutcome?.(kind, outcome);
    return outcome;
  }

  private async provision(hosted: HostedServer): Promise<ReconcileOutcome> {
    const { kube, template: t } = this.deps;
    const spec = hostedSpec(hosted);
    const ns = hostedNamespace(spec.slug);
    const deadline = hosted.deadline_at ?? new Date(this.now().getTime() + this.deps.timeoutMs);
    if (!hosted.deadline_at || hosted.namespace !== ns) {
      await updateHosted(this.deps.db, hosted.id, { deadline_at: deadline, namespace: ns });
    }
    let checksum = "";

    const steps: Step[] = [
      {
        name: "namespace",
        run: async () => {
          const waiting = await guardNamespace(kube, ns);
          if (waiting) return waiting;
          await kube.apply(hostedManifests(spec, t, "")[0]!);
        },
      },
      {
        name: "secrets",
        run: async () => {
          if (usesToken(spec)) await kube.create(bridgeAuthSecret(spec));
          checksum = await this.copyEnv(spec);
        },
      },
      {
        name: "resources",
        run: async () => {
          for (const obj of hostedManifests(spec, t, checksum).slice(1)) await kube.apply(obj);
          // Apply only adds and converges; what the spec no longer asks for goes explicitly.
          if (spec.egress === "none") {
            await kube.delete({
              apiVersion: "networking.k8s.io/v1",
              kind: "NetworkPolicy",
              metadata: { name: "allow-internet-egress", namespace: ns },
            });
          }
        },
      },
      {
        name: "server",
        run: () =>
          workloadReady(kube, ns, "Deployment", "server", {
            rollout: true,
            component: HOSTED_COMPONENT,
          }),
      },
      { name: "register", run: () => this.register(hosted, spec) },
    ];

    for (const step of steps) {
      const result = await step.run();
      if (result instanceof Waiting) {
        if (this.now() > deadline) {
          throw new ProvisionFailure(`timed out at ${step.name}: ${result.condition}`);
        }
        await this.recordProgress(hosted, step.name, result.condition);
        return "waiting";
      }
    }

    const ready = await transitionHosted(this.deps.db, hosted.id, ["provisioning"], {
      status: "ready",
      step: "ready",
      reason: null,
      server_id: hosted.id,
    });
    if (ready) log("info", "hosted server ready", { hosted: hosted.slug, image: hosted.image });
    return ready ? "ready" : "progress";
  }

  private async recordProgress(hosted: HostedServer, step: string, condition: string) {
    const reason = condition.slice(0, 500);
    if (hosted.step === step && hosted.reason === reason) return;
    hosted.step = step;
    hosted.reason = reason;
    await transitionHosted(this.deps.db, hosted.id, ["provisioning"], { step, reason });
  }

  /**
   * Copies the secret values the gateway stored into the server's namespace
   * (a pod can only use Secrets of its own namespace). Returns their
   * checksum, which goes on the pod template so a change restarts the pod.
   */
  private async copyEnv(spec: HostedSpec): Promise<string> {
    const { kube, secretsNamespace } = this.deps;
    const ref = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: SECRET_NAMES.env, namespace: hostedNamespace(spec.slug) },
    };
    if (!spec.secretEnvKeys.length) {
      await kube.delete(ref);
      return "";
    }
    const source = await kube.get<SecretObject>({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: hostedEnvSecretName(spec.id), namespace: secretsNamespace },
    });
    const data = source?.data ?? {};
    const missing = spec.secretEnvKeys.filter((k) => !(k in data));
    if (missing.length) {
      throw new ProvisionFailure(
        `secret values for ${missing.join(", ")} are missing; set them again`,
      );
    }
    const picked = Object.fromEntries(spec.secretEnvKeys.map((k) => [k, data[k]!]));
    await kube.apply(envSecret(spec, picked));
    return envChecksum(picked);
  }

  /**
   * The server becomes one of the gateway's upstreams, under the hosted
   * row's id (so a redo converges the same row). stdio servers sit behind
   * the bridge's token, http ones behind their own if they take one
   * (authTokenEnv); otherwise only the NetworkPolicy keeps everyone but the
   * gateway out.
   */
  private async register(hosted: HostedServer, spec: HostedSpec): Promise<void> {
    const { db, kube, credentials } = this.deps;
    const bearer = usesToken(spec);
    if (bearer) {
      const secret = await kube.get<SecretObject>({
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: SECRET_NAMES.bridgeAuth, namespace: hostedNamespace(spec.slug) },
      });
      const encoded = secret?.data?.token;
      if (!encoded) throw new ProvisionFailure("the server's token Secret is missing");
      await credentials.put(hosted.id, Buffer.from(encoded, "base64").toString("utf8"));
    }
    const taken = await db
      .selectFrom("mcp_servers")
      .select("id")
      .where("slug", "=", hosted.slug)
      .where("id", "!=", hosted.id)
      .executeTakeFirst();
    if (taken) throw new ProvisionFailure(`an MCP server named '${hosted.slug}' already exists`);
    const fields = {
      name: hosted.name,
      url: hostedMcpUrl(spec),
      auth_type: bearer ? ("bearer" as const) : ("none" as const),
      has_credential: bearer,
    };
    await db
      .insertInto("mcp_servers")
      .values({ id: hosted.id, slug: hosted.slug, managed_by: "hosted", ...fields })
      .onConflict((oc) => oc.column("id").doUpdateSet({ ...fields, updated_at: sql<Date>`now()` }))
      .execute();
    if (!bearer) await credentials.delete(hosted.id);
  }

  /** Gateway side first, then the namespace, then the stored secret values, then the row. */
  private async teardown(hosted: HostedServer): Promise<ReconcileOutcome> {
    const { db, kube, credentials, secretsNamespace } = this.deps;
    const removed = await db
      .deleteFrom("mcp_servers")
      .where("id", "=", hosted.id)
      .where("managed_by", "=", "hosted")
      .executeTakeFirst();
    if (removed.numDeletedRows > 0n) await deleteRulesForServer(db, hosted.slug);
    await credentials.delete(hosted.id);

    const name = hostedNamespace(hosted.slug);
    const ref = { apiVersion: "v1", kind: "Namespace", metadata: { name } };
    const ns = await kube.get(ref);
    if (ns) {
      if (ns.metadata.labels?.[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE) {
        throw new ProvisionFailure(
          `refusing to delete namespace ${name}: not managed by the provisioner`,
        );
      }
      if (!ns.metadata.deletionTimestamp) await kube.delete(ref);
      if (hosted.step !== "deleting-namespace") {
        await updateHosted(db, hosted.id, { step: "deleting-namespace", reason: null });
      }
      return "waiting";
    }
    await kube.delete({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: hostedEnvSecretName(hosted.id), namespace: secretsNamespace },
    });
    await deleteHostedRow(db, hosted.id);
    log("info", "hosted server deleted", { hosted: hosted.slug });
    return "deleted";
  }
}
