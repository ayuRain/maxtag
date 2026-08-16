#!/bin/sh
set -eu
umask 077

role="${1:-server}"

mkdir -p \
  "${OPENTAG_DATA_DIR:-/var/lib/opentag}" \
  "${OPENTAG_ARTIFACT_ROOT:-/var/lib/opentag/artifacts}" \
  "${OPENTAG_EXECUTOR_WORKSPACE_ROOT:-/srv/opentag/workspaces}"

standby() {
  echo "MaxTag ${role} is in Kubernetes standby mode."
  trap 'exit 0' TERM INT
  while :; do sleep 3600 & wait "$!"; done
}

case "$role" in
  server)
    exec node /app/apps/server/dist/index.js
    ;;
  worker)
    [ "${OPENTAG_K8S_WORKER_ENABLED:-false}" = "true" ] || standby
    exec node /app/apps/worker/dist/index.js
    ;;
  scheduler)
    [ "${OPENTAG_K8S_SCHEDULER_ENABLED:-false}" = "true" ] || standby
    exec node /app/apps/scheduler/dist/index.js
    ;;
  lark-bridge)
    [ "${OPENTAG_K8S_LARK_BRIDGE_ENABLED:-false}" = "true" ] || standby
    exec node /app/scripts/lark-long-connection-bridge.mjs
    ;;
  *)
    echo "Unknown MaxTag role: $role" >&2
    exit 64
    ;;
esac
