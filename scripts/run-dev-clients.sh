#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT/scripts/lib-dev-client-args.sh"
MODE="${1:-regular}"
[[ $# -gt 0 ]] && shift
normalize_dev_client_args "$@"
set -- "${NORMALIZED_ARGS[@]}"

cd "$ROOT"

if [[ $# -eq 0 ]]; then
  mapfile -t CLIENTS < <(normalize_clients_list web tui)
else
  mapfile -t CLIENTS < <(normalize_clients_list "$@")
fi

if [[ "$MODE" == "portless" ]]; then
  if printf '%s\n' "${CLIENTS[@]}" | grep -qx web; then
    export VITE_API_URL="${VITE_API_URL:-http://api.qwery.localhost:1355/api}"
    export VITE_DEV_API_PROXY="${VITE_DEV_API_PROXY:-http://api.qwery.localhost:1355}"
  fi
fi

PIDS=()
cleanup_dev_clients() {
  for p in "${PIDS[@]:-}"; do
    kill -TERM "$p" 2>/dev/null || true
    pkill -TERM -P "$p" 2>/dev/null || true
  done
}
trap cleanup_dev_clients EXIT INT TERM

start() {
  "$@" &
  PIDS+=($!)
}

# Launch mapping must stay in sync with QWERY_DEV_CLIENT_IDS in lib-dev-client-args.sh
for c in "${CLIENTS[@]}"; do
  case "$c" in
    web)
      if [[ "$MODE" == "portless" ]]; then
        start pnpm web:dev:portless
      else
        start pnpm web:dev
      fi
      ;;
    tui) start pnpm tui:dev ;;
    desktop) start pnpm desktop:dev ;;
  esac
done

finalize_dev_clients_wait() {
  local i pid
  if [[ ${BASH_VERSINFO[0]} -gt 4 ]] ||
    { [[ ${BASH_VERSINFO[0]} -eq 4 ]] && [[ ${BASH_VERSINFO[1]} -ge 3 ]]; }; then
    for ((i = 0; i < ${#PIDS[@]}; i++)); do
      wait -n || exit $?
    done
    exit 0
  fi
  for pid in "${PIDS[@]}"; do
    wait "$pid" || exit $?
  done
  exit 0
}
finalize_dev_clients_wait
