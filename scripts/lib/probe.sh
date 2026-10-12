# Shared by the verify scripts. The urumi namespace enforces the "restricted"
# Pod Security profile, so even a throwaway curl pod must be non-root, drop
# all capabilities and set a seccomp profile (a bare `kubectl run` is refused).
#
#   run_probe NAME LABELS SCRIPT [NAMESPACE] [ENV_NAME=VALUE]
#
# Runs SCRIPT with `sh -c` in a throwaway curl pod named NAME, prints its
# output, and removes the pod. LABELS is "" or "k=v".
run_probe() {
  local name="$1" labels="$2" script="$3" ns="${4:-${NS:-urumi}}" envkv="${5:-}"
  local overrides
  overrides=$(NAME="$name" SCRIPT="$script" ENVKV="$envkv" python3 -c '
import json, os
c = {
  "name": os.environ["NAME"],
  "image": "curlimages/curl:8.11.1",
  "command": ["sh", "-c", os.environ["SCRIPT"]],
  "securityContext": {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True,
                      "capabilities": {"drop": ["ALL"]}},
}
if os.environ["ENVKV"]:
  k, v = os.environ["ENVKV"].split("=", 1)
  c["env"] = [{"name": k, "value": v}]
print(json.dumps({"spec": {"automountServiceAccountToken": False,
  "securityContext": {"runAsNonRoot": True, "runAsUser": 100, "seccompProfile": {"type": "RuntimeDefault"}},
  "containers": [c]}}))')
  local args=(-n "$ns" run "$name" --rm -i --restart=Never --quiet --image=curlimages/curl:8.11.1 --overrides="$overrides")
  [ -n "$labels" ] && args+=(--labels="$labels")
  kubectl "${args[@]}"
}
