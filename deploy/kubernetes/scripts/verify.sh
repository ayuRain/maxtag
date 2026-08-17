#!/bin/sh
set -eu

namespace="${1:-maxtag}"
kubectl -n "$namespace" rollout status statefulset/maxtag --timeout=10m
control_plane_pod="$(kubectl -n "$namespace" get pod \
  -l 'app.kubernetes.io/name=maxtag,app.kubernetes.io/component=control-plane' \
  -o jsonpath='{.items[0].metadata.name}')"
[ -n "$control_plane_pod" ] || { echo "MaxTag control-plane Pod not found" >&2; exit 1; }
kubectl -n "$namespace" exec "$control_plane_pod" -c server -- \
  node -e "fetch('http://127.0.0.1:3077/health').then(async r => { if (!r.ok) process.exit(1); console.log(await r.text()) })"
kubectl -n "$namespace" exec "$control_plane_pod" -c server -- \
  sqlite3 /var/lib/opentag/opentag.sqlite 'PRAGMA quick_check;' | grep -qx ok
for port in 3078 3079 3080; do
  kubectl -n "$namespace" exec "$control_plane_pod" -c server -- \
    node -e "fetch('http://127.0.0.1:${port}/health').then(r => { if (!r.ok) process.exit(1) })"
done
echo "MaxTag Kubernetes verification passed."
