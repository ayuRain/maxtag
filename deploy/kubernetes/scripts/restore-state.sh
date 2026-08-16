#!/bin/sh
set -eu

archive="${1:-}"
namespace="${2:-maxtag}"
if [ -z "$archive" ] || [ ! -f "$archive" ]; then
  echo "usage: $0 <state.tar.gz> [namespace]" >&2
  exit 64
fi

if [ -f "$archive.sha256" ]; then
  (cd "$(dirname "$archive")" && sha256sum -c "$(basename "$archive").sha256")
fi

replicas="$(kubectl -n "$namespace" get statefulset maxtag -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0)"
if [ "$replicas" != "0" ]; then
  echo "statefulset/maxtag must be scaled to zero before restoring state" >&2
  exit 1
fi

pod="maxtag-state-restore"
kubectl -n "$namespace" delete pod "$pod" --ignore-not-found --wait >/dev/null
cat <<EOF | kubectl -n "$namespace" apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: $pod
spec:
  restartPolicy: Never
  containers:
    - name: restore
      image: busybox:1.36.1
      command: ["sh", "-c", "sleep 3600"]
      volumeMounts:
        - name: state
          mountPath: /mnt
  volumes:
    - name: state
      persistentVolumeClaim:
        claimName: maxtag-state
EOF
trap 'kubectl -n "$namespace" delete pod "$pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true' EXIT HUP INT TERM
kubectl -n "$namespace" wait --for=condition=Ready "pod/$pod" --timeout=5m >/dev/null
kubectl -n "$namespace" cp "$archive" "$pod:/tmp/state.tar.gz"
kubectl -n "$namespace" exec "$pod" -- sh -ec '
  rm -rf /mnt/state /mnt/workspaces
  mkdir -p /mnt
  tar -C /mnt -xzf /tmp/state.tar.gz
  chown -R 1000:1000 /mnt/state /mnt/workspaces
  test -s /mnt/state/opentag.sqlite
'
kubectl -n "$namespace" delete pod "$pod" --wait >/dev/null
trap - EXIT HUP INT TERM
echo "State restored to PVC maxtag-state in namespace $namespace."
