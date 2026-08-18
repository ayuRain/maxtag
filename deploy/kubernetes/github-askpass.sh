#!/bin/sh
set -eu

case "${1:-}" in
  *Username*|*username*)
    printf '%s\n' 'x-access-token'
    ;;
  *)
    [ -n "${GITHUB_TOKEN:-}" ] || exit 1
    printf '%s\n' "$GITHUB_TOKEN"
    ;;
esac
