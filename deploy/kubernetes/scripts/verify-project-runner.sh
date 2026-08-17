#!/bin/sh
set -eu

namespace="${1:-maxtag}"

kubectl -n "$namespace" rollout status deployment/maxtag-project-runner --timeout=10m

control_plane_pod="$(kubectl -n "$namespace" get pod \
  -l 'app.kubernetes.io/name=maxtag,app.kubernetes.io/component=control-plane' \
  -o jsonpath='{.items[0].metadata.name}')"
runner_pod="$(kubectl -n "$namespace" get pod \
  -l 'app.kubernetes.io/name=maxtag-project-runner,app.kubernetes.io/component=project-runner' \
  -o jsonpath='{.items[0].metadata.name}')"

[ -n "$control_plane_pod" ] || { echo "MaxTag control-plane Pod not found" >&2; exit 1; }
[ -n "$runner_pod" ] || { echo "MaxTag Project Runner Pod not found" >&2; exit 1; }

# Exercise the authenticated control-plane -> runner path. The token stays in
# the worker environment and is never copied to this process or printed.
kubectl -n "$namespace" exec "$control_plane_pod" -c worker -- node -e '
const token = process.env.OPENTAG_PROJECT_RUNNER_TOKEN;
const url = process.env.OPENTAG_PROJECT_RUNNER_URL;
if (!token || !url) throw new Error("project runner is not configured");
fetch(`${url}/v1/execute`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({
    projectKey: "runner-verification",
    command: "node",
    args: ["-e", "process.stdout.write(\"project-runner-ok\")"],
    timeoutMs: 10000,
    maxOutputBytes: 4096
  })
}).then(async (response) => {
  const body = await response.text();
  if (!response.ok) throw new Error(`runner returned ${response.status}: ${body}`);
  const result = JSON.parse(body);
  if (result.exitCode !== 0 || result.stdout !== "project-runner-ok") {
    throw new Error(`unexpected runner result: ${body}`);
  }
  console.log("project-runner-ok");
});
'

# The runner must not inherit cluster or control-plane credentials.
kubectl -n "$namespace" exec "$runner_pod" -c project-runner -- sh -ceu '
  test ! -e /var/run/secrets/kubernetes.io/serviceaccount/token
  test ! -e /var/run/secrets/maxtag-github-app/private-key.pem
  test -z "${AWS_ACCESS_KEY_ID:-}"
  test -z "${AWS_SECRET_ACCESS_KEY:-}"
  test -z "${LARK_APP_SECRET:-}"
'

# A NetworkPolicy object is not proof that the CNI enforces it. This probe must
# fail; a successful request means the runner unexpectedly has direct egress.
kubectl -n "$namespace" exec "$runner_pod" -c project-runner -- \
  sh -ceu 'command -v curl >/dev/null'
if kubectl -n "$namespace" exec "$runner_pod" -c project-runner -- \
  curl -fsS --max-time 5 https://api.github.com >/dev/null 2>&1; then
  echo "Project Runner has unexpected direct internet egress" >&2
  exit 1
fi

echo "MaxTag Project Runner isolation verification passed."
