import type { K8sClient } from "../k8s/client.js";
import { MANAGED_BY_LABEL, MANAGED_BY_VALUE } from "./manifests/store.js";

/**
 * Cluster checks shared by the store and hosted-server reconcilers. A check
 * returns a `Waiting` when it can't make progress until something in the
 * cluster changes, and throws a `ProvisionFailure` when it failed for good
 * (until the user retries).
 */
export class Waiting {
  constructor(readonly condition: string) {}
}
export class ProvisionFailure extends Error {}

export type Step = { name: string; run: () => Promise<Waiting | void> };

/** Never adopt a namespace the provisioner didn't create (e.g. kube-system, or a typo'd collision). */
export async function guardNamespace(kube: K8sClient, name: string): Promise<Waiting | void> {
  const existing = await kube.get({ apiVersion: "v1", kind: "Namespace", metadata: { name } });
  if (existing && existing.metadata.labels?.[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE) {
    throw new ProvisionFailure(
      `namespace ${name} already exists and is not managed by the provisioner`,
    );
  }
  if (existing?.metadata.deletionTimestamp) {
    return new Waiting(`namespace ${name} is still being deleted`);
  }
}

interface WorkloadStatus {
  observedGeneration?: number;
  replicas?: number;
  readyReplicas?: number;
  updatedReplicas?: number;
  availableReplicas?: number;
  conditions?: { type: string; status: string; message?: string }[];
}

/**
 * Whether a Deployment/StatefulSet has a ready pod. With `rollout`, the
 * current spec must also be fully rolled out - after an update the old pod
 * is still ready, and that must not count.
 */
export async function workloadReady(
  kube: K8sClient,
  ns: string,
  kind: "Deployment" | "StatefulSet",
  name: string,
  opts: { rollout?: boolean; component?: string } = {},
): Promise<Waiting | void> {
  const obj = await kube.get({ apiVersion: "apps/v1", kind, metadata: { name, namespace: ns } });
  if (!obj) return new Waiting(`${name} not created yet`);
  const status = (obj.status ?? {}) as WorkloadStatus;
  const generation = (obj.metadata as { generation?: number }).generation;
  const ready = (status.readyReplicas ?? 0) >= 1;
  const rolledOut =
    !opts.rollout ||
    ((generation === undefined || (status.observedGeneration ?? 0) >= generation) &&
      (status.updatedReplicas ?? 0) >= 1 &&
      (status.replicas ?? 0) === (status.updatedReplicas ?? 0) &&
      (status.availableReplicas ?? 0) >= 1);
  if (ready && rolledOut) return;
  // A quota refusal shows up on the Deployment (its ReplicaSet can't create pods).
  const failure = status.conditions?.find(
    (c) => c.type === "ReplicaFailure" && c.status === "True",
  );
  if (failure?.message) return new Waiting(`${name}: ${failure.message}`);
  return new Waiting(await podProblem(kube, ns, opts.component ?? name));
}

interface PodStatus {
  phase?: string;
  conditions?: { type: string; status: string; reason?: string; message?: string }[];
  initContainerStatuses?: ContainerStatus[];
  containerStatuses?: ContainerStatus[];
}
interface Terminated {
  exitCode?: number;
  reason?: string;
}
interface ContainerStatus {
  name?: string;
  state?: { waiting?: { reason?: string; message?: string }; terminated?: Terminated };
  lastState?: { terminated?: Terminated };
}

/** ", exit code 137 (OOMKilled)": the reason only when it says more than "Error". */
const exitText = (t: Terminated) =>
  `, exit code ${t.exitCode ?? "?"}${t.reason && t.reason !== "Error" ? ` (${t.reason})` : ""}`;

/**
 * The most telling reason a component's pods aren't ready yet:
 * ImagePullBackOff, CrashLoopBackOff (with the exit code and the crashed
 * run's last log line), unschedulable, ...
 */
export async function podProblem(kube: K8sClient, ns: string, component: string): Promise<string> {
  const pods = await kube.list("v1", "Pod", {
    namespace: ns,
    labelSelector: `app.kubernetes.io/component=${component}`,
  });
  for (const pod of pods) {
    const status = (pod.status ?? {}) as PodStatus;
    const init = new Set((status.initContainerStatuses ?? []).map((c) => c.name));
    for (const c of [
      ...(status.initContainerStatuses ?? []),
      ...(status.containerStatuses ?? []),
    ]) {
      const isInit = init.has(c.name);
      const where = isInit ? `${component} (init container ${c.name})` : component;
      // Between restarts an init container shows as terminated rather than waiting.
      const dead = c.state?.terminated;
      if (isInit && dead && dead.exitCode !== 0) {
        return `${where}: ${dead.reason ?? "failed"}, exit code ${dead.exitCode ?? "?"}`;
      }
      const w = c.state?.waiting;
      if (!w?.reason || w.reason === "ContainerCreating" || w.reason === "PodInitializing") {
        continue;
      }
      let text = `${where}: ${w.reason}${w.message ? ` (${w.message})` : ""}`;
      const exited = c.lastState?.terminated;
      if (w.reason === "CrashLoopBackOff" && exited) {
        text += exitText(exited);
        if (isInit) return text; // the log endpoint defaults to the main container
        const tail = (await kube.podLogTail(ns, pod.metadata.name, 1, true))
          .split("\n")
          .at(-1)
          ?.slice(0, 200);
        if (tail) text += `; last log line: ${tail}`;
      }
      return text;
    }
    const unscheduled = status.conditions?.find(
      (c) => c.type === "PodScheduled" && c.status === "False",
    );
    if (unscheduled) {
      return `${component}: unschedulable (${unscheduled.message ?? unscheduled.reason})`;
    }
  }
  return pods.length ? `waiting for ${component} to become ready` : `waiting for ${component} pods`;
}
