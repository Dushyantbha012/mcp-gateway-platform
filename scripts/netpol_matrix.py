#!/usr/bin/env python3
"""Proves the NetworkPolicies by trying every flow from real pod identities.

For each SOURCE a throwaway curl pod is started carrying that workload's
labels (so the same NetworkPolicies select it as the real pod), plus one pod
in a different namespace. Each pod tries a TCP connect to every TARGET. The
result is compared with EXPECT; anything not listed there must be blocked, so
a new flow can't slip in unnoticed. Prints a table and exits 1 on any mismatch.

  scripts/netpol_matrix.py [namespace] [release]
"""
import concurrent.futures as cf
import json
import subprocess
import sys

NS = sys.argv[1] if len(sys.argv) > 1 else "urumi"
REL = sys.argv[2] if len(sys.argv) > 2 else "platform"
OTHER_NS = "np-other"

# name -> "host:port". Fully qualified so a pod in another namespace resolves
# them too: otherwise "blocked" could just mean "DNS failed".
TARGETS = {
    "postgres": f"{REL}-gateway-postgres.{NS}.svc.cluster.local:5432",
    "woocommerce-mcp": f"{REL}-store-woocommerce-mcp.{NS}.svc.cluster.local:3000",
    "wordpress": f"{REL}-store-wordpress.{NS}.svc.cluster.local:80",
    "mysql": f"{REL}-store-mysql.{NS}.svc.cluster.local:3306",
    "gateway": f"{REL}-gateway.{NS}.svc.cluster.local:80",
    "dashboard": f"{REL}-dashboard.{NS}.svc.cluster.local:80",
    "k8s-api": "kubernetes.default.svc:443",
    "kubelet": "NODE_IP:10250",
    "cloud-metadata": "169.254.169.254:80",
    "internet": "api.github.com:443",
}

# source -> (labels, namespace)
SOURCES = {
    "unlabelled pod": ({}, NS),
    "gateway": (
        {
            "app.kubernetes.io/instance": f"{REL}-gateway",
            "app.kubernetes.io/component": "gateway",
            "urumi.ai/mcp-client": "true",
        },
        NS,
    ),
    "dashboard": (
        {"app.kubernetes.io/instance": f"{REL}-dashboard", "app.kubernetes.io/component": "dashboard"},
        NS,
    ),
    "woocommerce-mcp": (
        {"app.kubernetes.io/instance": f"{REL}-store", "app.kubernetes.io/component": "woocommerce-mcp"},
        NS,
    ),
    "wordpress": (
        {"app.kubernetes.io/instance": f"{REL}-store", "app.kubernetes.io/component": "wordpress"},
        NS,
    ),
    "bootstrap job": (
        {"app.kubernetes.io/instance": f"{REL}-store", "app.kubernetes.io/component": "bootstrap"},
        NS,
    ),
    "postgres": (
        {"app.kubernetes.io/instance": f"{REL}-gateway", "app.kubernetes.io/component": "postgres"},
        NS,
    ),
    "mysql": (
        {"app.kubernetes.io/instance": f"{REL}-store", "app.kubernetes.io/component": "mysql"},
        NS,
    ),
    "pod in another namespace": ({}, OTHER_NS),
}

# Everything not listed here must be blocked.
EXPECT_OPEN = {
    "gateway": {"postgres", "woocommerce-mcp", "k8s-api", "internet"},
    "woocommerce-mcp": {"wordpress"},
    "wordpress": {"mysql"},
    "bootstrap job": {"mysql", "internet"},
}


# The other namespace has no policies of its own, so only what it can reach
# *into* ours is meaningful there (our ingress rules), not the outside world.
NOT_APPLICABLE = {"pod in another namespace": {"k8s-api", "kubelet", "cloud-metadata", "internet"}}


def sh(*args, input=None, check=True):
    return subprocess.run(args, input=input, capture_output=True, text=True, check=check)


def node_ip() -> str:
    out = sh("kubectl", "get", "nodes", "-o", "jsonpath={.items[0].status.addresses[?(@.type=='InternalIP')].address}")
    return out.stdout.strip()


def probe(source: str, targets: dict[str, str]) -> dict[str, bool]:
    labels, namespace = SOURCES[source]
    name = "np-" + "".join(c if c.isalnum() else "-" for c in source.lower())[:30].strip("-")
    checks = "\n".join(
        f"""( curl -sv --max-time 4 telnet://{addr} </dev/null 2>&1 | grep -q 'Connected to' \
&& echo '{t}=open' || echo '{t}=blocked' ) &"""
        for t, addr in targets.items()
    )
    # Short sleep first: a new pod is admitted by the policy controller after a moment.
    script = f"sleep 4\n{checks}\nwait"
    container = {
        "name": name,
        "image": "curlimages/curl:8.11.1",
        "command": ["sh", "-c", script],
        "securityContext": {
            "allowPrivilegeEscalation": False,
            "readOnlyRootFilesystem": True,
            "capabilities": {"drop": ["ALL"]},
        },
    }
    overrides = {
        "spec": {
            "automountServiceAccountToken": False,
            "securityContext": {
                "runAsNonRoot": True,
                "runAsUser": 100,
                "seccompProfile": {"type": "RuntimeDefault"},
            },
            "containers": [container],
        }
    }
    args = [
        "kubectl", "-n", namespace, "run", name, "--rm", "-i", "--restart=Never", "--quiet",
        "--image=curlimages/curl:8.11.1", f"--overrides={json.dumps(overrides)}",
    ]
    if labels:
        args.append("--labels=" + ",".join(f"{k}={v}" for k, v in labels.items()))
    out = sh(*args, check=False).stdout
    result = {}
    for line in out.splitlines():
        if "=" in line and line.split("=")[1] in ("open", "blocked"):
            t, state = line.split("=")
            result[t.strip()] = state == "open"
    return result


def main() -> int:
    targets = {t: a.replace("NODE_IP", node_ip()) for t, a in TARGETS.items()}
    sh("kubectl", "create", "namespace", OTHER_NS, check=False)
    try:
        with cf.ThreadPoolExecutor(max_workers=len(SOURCES)) as pool:
            results = dict(zip(SOURCES, pool.map(lambda s: probe(s, targets), SOURCES)))
    finally:
        sh("kubectl", "delete", "namespace", OTHER_NS, "--wait=false", check=False)

    names = list(TARGETS)
    width = max(len(s) for s in SOURCES)
    print(f"{'from \\ to':<{width}}  " + "  ".join(f"{n[:9]:<9}" for n in names))
    failures = []
    for source, got in results.items():
        cells = []
        for t in names:
            if t in NOT_APPLICABLE.get(source, set()):
                cells.append("n/a      ")
                continue
            want_open = t in EXPECT_OPEN.get(source, set())
            if t not in got:
                cells.append("NO DATA  ")
                failures.append(f"{source} -> {t}: no result from the probe")
                continue
            ok = got[t] == want_open
            cells.append(("open " if got[t] else "block") + (" ok  " if ok else " FAIL"))
            if not ok:
                failures.append(
                    f"{source} -> {t}: {'open' if got[t] else 'blocked'}, expected "
                    f"{'open' if want_open else 'blocked'}"
                )
        print(f"{source:<{width}}  " + "  ".join(f"{c:<9}" for c in cells))
    print()
    for f in failures:
        print("FAIL", f)
    total = sum(len(TARGETS) - len(NOT_APPLICABLE.get(s, ())) for s in SOURCES)
    print(f"{total - len(failures)}/{total} flows as expected")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
