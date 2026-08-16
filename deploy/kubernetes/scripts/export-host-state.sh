#!/bin/sh
set -eu

output="${1:-}"
if [ -z "$output" ]; then
  echo "usage: $0 <output.tar.gz>" >&2
  exit 64
fi

for unit in opentag-server opentag-worker opentag-scheduler opentag-lark-bridge; do
  if systemctl is-active --quiet "$unit"; then
    echo "$unit is active; stop all MaxTag writers before exporting state" >&2
    exit 1
  fi
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
mkdir -p "$tmp/state" "$tmp/workspaces"
cp -a /var/lib/opentag/. "$tmp/state/"
if [ -d /srv/opentag/workspaces ]; then
  cp -a /srv/opentag/workspaces/. "$tmp/workspaces/"
fi
sqlite3 "$tmp/state/opentag.sqlite" 'PRAGMA quick_check;' | grep -qx ok
tar -C "$tmp" -czf "$output" state workspaces
chmod 600 "$output"
sha256sum "$output" > "$output.sha256"
chmod 600 "$output.sha256"
echo "State export created at $output"
