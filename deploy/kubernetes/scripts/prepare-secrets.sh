#!/bin/sh
set -eu

namespace="${1:-maxtag}"
env_file="${2:-}"
cloudflared_config="${3:-}"
cloudflared_credentials="${4:-}"

if [ -z "$env_file" ] || [ ! -f "$env_file" ]; then
  echo "usage: $0 <namespace> <runtime-env-file> [cloudflared-config cloudflared-credentials]" >&2
  exit 64
fi

kubectl create namespace "$namespace" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n "$namespace" create secret generic maxtag-runtime-env \
  --from-env-file="$env_file" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

if [ -n "$cloudflared_config" ] || [ -n "$cloudflared_credentials" ]; then
  if [ ! -f "$cloudflared_config" ] || [ ! -f "$cloudflared_credentials" ]; then
    echo "both cloudflared config and credentials files are required" >&2
    exit 64
  fi
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT HUP INT TERM
  cp "$cloudflared_credentials" "$tmp/credentials.json"
  sed \
    -e 's#^[[:space:]]*credentials-file:.*#credentials-file: /etc/cloudflared/credentials.json#' \
    -e 's#^[[:space:]]*metrics:.*#metrics: 0.0.0.0:3090#' \
    -e 's#service: http://127\.0\.0\.1:3077#service: http://127.0.0.1:3077#' \
    "$cloudflared_config" > "$tmp/config.yml"
  kubectl -n "$namespace" create secret generic maxtag-cloudflared \
    --from-file=config.yml="$tmp/config.yml" \
    --from-file=credentials.json="$tmp/credentials.json" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
fi

echo "MaxTag Kubernetes secrets applied in namespace $namespace."
