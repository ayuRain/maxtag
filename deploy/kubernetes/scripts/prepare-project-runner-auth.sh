#!/bin/sh
set -eu

namespace="${1:-maxtag}"
secret="${2:-maxtag-project-runner-auth}"

kubectl create namespace "$namespace" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
if kubectl -n "$namespace" get secret "$secret" >/dev/null 2>&1; then
  echo "Project runner auth Secret already exists in namespace $namespace."
  exit 0
fi

token="$(openssl rand -hex 32)"
kubectl -n "$namespace" create secret generic "$secret" \
  --from-literal=token="$token" >/dev/null
unset token
echo "Project runner auth Secret created in namespace $namespace."
