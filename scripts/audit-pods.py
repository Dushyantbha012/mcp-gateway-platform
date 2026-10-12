#!/usr/bin/env python3
"""Fails if any pod in the namespace is not hardened.

Reads `kubectl get pods -o json` (or the same shape on stdin with --stdin,
e.g. from scripts/manifests-to-pods.mjs for `helm template` output) and checks every container against a baseline:

  - runs as non-root (pod or container level)
  - allowPrivilegeEscalation: false
  - drops ALL capabilities and adds none
  - seccomp RuntimeDefault (or Localhost)
  - read-only root filesystem
  - no service-account token, unless the pod is on the reviewed allowlist
  - not privileged, no hostNetwork/hostPID/hostPath

EXCEPTIONS is the only way around a rule. Each entry needs a reason; the
point is that a weakness is written down and reviewed, never silent.
Usage: audit-pods.py [namespace]   |   kubectl ... -o json | audit-pods.py --stdin
"""
import json
import subprocess
import sys

# (pod name prefix, rule) -> reason
EXCEPTIONS: dict[tuple[str, str], str] = {}

def allowed_token(labels: dict) -> bool:
    """Only the gateway calls the Kubernetes API (it manages upstream Secrets)."""
    return labels.get("app.kubernetes.io/component") == "gateway"


def check(pod: dict) -> list[str]:
    name = pod["metadata"]["name"]
    labels = pod["metadata"].get("labels", {})
    spec = pod["spec"]
    psc = spec.get("securityContext", {}) or {}
    problems: list[str] = []

    def bad(rule: str, msg: str):
        if not any(name.startswith(p) and r == rule for (p, r) in EXCEPTIONS):
            problems.append(f"{name}: {rule}: {msg}")

    for flag in ("hostNetwork", "hostPID", "hostIPC"):
        if spec.get(flag):
            bad(flag, "enabled")
    for v in spec.get("volumes", []):
        if "hostPath" in v:
            bad("hostPath", f"volume {v['name']}")
    if spec.get("automountServiceAccountToken") is not False and not allowed_token(labels):
        bad("sa-token", "service-account token is mounted")

    for c in spec.get("containers", []) + spec.get("initContainers", []):
        sc = c.get("securityContext", {}) or {}
        who = f"container {c['name']}"
        user = sc.get("runAsUser", psc.get("runAsUser"))
        non_root = sc.get("runAsNonRoot", psc.get("runAsNonRoot"))
        if not non_root or user == 0:
            bad("non-root", f"{who} may run as root")
        if sc.get("allowPrivilegeEscalation") is not False:
            bad("no-privilege-escalation", who)
        caps = sc.get("capabilities", {}) or {}
        if caps.get("drop") != ["ALL"] or caps.get("add"):
            bad("drop-all-capabilities", f"{who} caps={caps}")
        seccomp = (sc.get("seccompProfile") or psc.get("seccompProfile") or {}).get("type")
        if seccomp not in ("RuntimeDefault", "Localhost"):
            bad("seccomp", f"{who} has {seccomp!r}")
        if sc.get("readOnlyRootFilesystem") is not True:
            bad("read-only-rootfs", who)
        if sc.get("privileged"):
            bad("privileged", who)
    return problems


def main() -> int:
    if "--stdin" in sys.argv:
        data = json.load(sys.stdin)
    else:
        ns = next((a for a in sys.argv[1:] if not a.startswith("-")), "urumi")
        data = json.loads(
            subprocess.check_output(["kubectl", "-n", ns, "get", "pods", "-o", "json"])
        )
    pods = data["items"]
    problems = [p for pod in pods for p in check(pod)]
    for p in problems:
        print("FAIL", p)
    print(f"audited {len(pods)} pod(s): {'OK' if not problems else str(len(problems)) + ' problem(s)'}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
