// Turns `helm template` output (multi-document YAML on stdin) into a
// `kubectl get pods -o json`-shaped list of the pod templates inside every
// Deployment, StatefulSet, Job and DaemonSet, so scripts/audit-pods.py can
// check what would be deployed without needing a cluster.
//   helm template platform helm -f helm/values-local.yaml | node scripts/manifests-to-pods.mjs | python3 scripts/audit-pods.py --stdin
import { loadAll } from "js-yaml";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const items = [];
for (const doc of loadAll(input)) {
  if (!doc || !["Deployment", "StatefulSet", "Job", "DaemonSet"].includes(doc.kind)) continue;
  const tpl = doc.spec.template;
  items.push({
    metadata: { name: doc.metadata.name, labels: tpl.metadata?.labels ?? {} },
    spec: tpl.spec,
  });
}
process.stdout.write(JSON.stringify({ items }));
