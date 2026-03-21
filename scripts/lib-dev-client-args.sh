#!/usr/bin/env bash
# shellcheck shell=bash
# Single source of truth for dev stack client ids (add new clients here only).

QWERY_DEV_CLIENT_IDS=(web tui desktop)

dev_client_usage_hint() {
  local s
  s=$(printf '%s, ' "${QWERY_DEV_CLIENT_IDS[@]}")
  printf '%s, all' "${s%, }"
}

# Normalizes args after pnpm passes a literal "--" or flags like "--web".
normalize_dev_client_args() {
  NORMALIZED_ARGS=()
  local a id found
  for a in "$@"; do
    case "$a" in
      --) ;;
      --all) NORMALIZED_ARGS+=(all) ;;
      --*)
        found=0
        for id in "${QWERY_DEV_CLIENT_IDS[@]}"; do
          if [[ "$a" == "--$id" ]]; then
            NORMALIZED_ARGS+=("$id")
            found=1
            break
          fi
        done
        if [[ $found -eq 0 ]]; then
          echo "dev client args: unknown flag '$a' (use: $(dev_client_usage_hint))" >&2
          return 1
        fi
        ;;
      *)
        NORMALIZED_ARGS+=("$a")
        ;;
    esac
  done
}

# Expands "all", dedupes, validates against QWERY_DEV_CLIENT_IDS. Prints one client per line.
normalize_clients_list() {
  local -a out=()
  local -A seen=()
  local w x ok
  for w in "$@"; do
    case "$w" in
      all)
        for x in "${QWERY_DEV_CLIENT_IDS[@]}"; do
          [[ -n "${seen[$x]:-}" ]] && continue
          seen[$x]=1
          out+=("$x")
        done
        ;;
      *)
        ok=0
        for x in "${QWERY_DEV_CLIENT_IDS[@]}"; do
          if [[ "$w" == "$x" ]]; then
            ok=1
            break
          fi
        done
        if [[ $ok -eq 1 ]]; then
          [[ -n "${seen[$w]:-}" ]] && continue
          seen[$w]=1
          out+=("$w")
        else
          echo "run-dev-clients: unknown client '$w' (use: $(dev_client_usage_hint))" >&2
          return 1
        fi
        ;;
    esac
  done
  if [[ ${#out[@]} -eq 0 ]]; then
    echo "run-dev-clients: pick at least one client ($(dev_client_usage_hint))" >&2
    return 1
  fi
  printf '%s\n' "${out[@]}"
}
