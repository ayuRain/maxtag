#!/bin/sh
set -eu

namespace="${1:-maxtag}"
kubectl -n "$namespace" rollout status statefulset/maxtag --timeout=10m
kubectl -n "$namespace" exec statefulset/maxtag -c server -- \
  node -e "fetch('http://127.0.0.1:3077/health').then(async r => { if (!r.ok) process.exit(1); console.log(await r.text()) })"
kubectl -n "$namespace" exec statefulset/maxtag -c server -- \
  sqlite3 /var/lib/opentag/opentag.sqlite 'PRAGMA quick_check;' | grep -qx ok
for port in 3078 3079 3080; do
  kubectl -n "$namespace" exec statefulset/maxtag -c server -- \
    node -e "fetch('http://127.0.0.1:${port}/health').then(r => { if (!r.ok) process.exit(1) })"
done
echo "MaxTag Kubernetes verification passed."
