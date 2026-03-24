#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT/scripts/lib-dev-client-args.sh"

# Optional first token: portless | regular (so: pnpm dev:terminals -- portless web)
MODE=regular
REST=("$@")
if [[ ${#REST[@]} -gt 0 ]]; then
  case "${REST[0]}" in
    portless)
      MODE=portless
      REST=("${REST[@]:1}")
      ;;
    regular)
      MODE=regular
      REST=("${REST[@]:1}")
      ;;
  esac
fi
normalize_dev_client_args "${REST[@]}"
CLIENT_ARGS=("${NORMALIZED_ARGS[@]}")
WRAPPER="$ROOT/scripts/exec-dev-stack-clients.sh"

if [[ "$MODE" == "portless" ]]; then
  SERVER_CMD="pnpm server:dev:portless"
  RUN_NAME="dev:stack:clients:portless"
else
  SERVER_CMD="pnpm server:dev"
  RUN_NAME="dev:stack:clients"
fi

SERVER_INNER=$(printf 'cd %q && %s' "$ROOT" "$SERVER_CMD")

clients_inner() {
  printf 'exec %q %q %q' "$WRAPPER" "$ROOT" "$RUN_NAME"
  local a
  for a in "${CLIENT_ARGS[@]}"; do
    printf ' %q' "$a"
  done
}

CLIENTS_INNER=$(clients_inner)

# AppleScript double-quoted strings; paths should already use shell-safe quoting (e.g. %q for ROOT).
apple_escape() {
  local x=$1
  x=${x//\\/\\\\}
  x=${x//\"/\\\"}
  printf '%s' "$x"
}

open_macos_terminal_app() {
  local s1 s2
  s1=$(apple_escape "${SERVER_INNER}; exec bash")
  s2=$(apple_escape "${CLIENTS_INNER}; exec bash")
  osascript <<EOF
tell application "Terminal"
    do script "$s1"
    do script "$s2"
end tell
EOF
}

open_macos_iterm() {
  local s1 s2
  s1=$(apple_escape "${SERVER_INNER}; exec bash")
  s2=$(apple_escape "${CLIENTS_INNER}; exec bash")
  osascript <<EOF
tell application "iTerm"
    create window with default profile
    tell current session of current window
        write text "$s1"
    end tell
    create window with default profile
    tell current session of current window
        write text "$s2"
    end tell
end tell
EOF
}

iterm_available() {
  [[ -d "/Applications/iTerm.app" ]] ||
    [[ -d "${HOME}/Applications/iTerm.app" ]]
}

open_macos() {
  case "${QWERY_DEV_TERMINAL:-auto}" in
    iterm | iTerm)
      open_macos_iterm
      ;;
    terminal | Terminal)
      open_macos_terminal_app
      ;;
    auto)
      if iterm_available; then
        open_macos_iterm || {
          echo "open-dev-terminals: iTerm launch failed; falling back to Terminal.app" >&2
          open_macos_terminal_app
        }
      else
        open_macos_terminal_app
      fi
      ;;
    *)
      echo "open-dev-terminals: unknown QWERY_DEV_TERMINAL=${QWERY_DEV_TERMINAL} (use: auto, iterm, terminal)" >&2
      open_macos_terminal_app
      ;;
  esac
}

open_linux() {
  local term="$1" title="$2" inner="$3"
  case "$term" in
    gnome-terminal)
      gnome-terminal --title="$title" -- bash -lc "$inner" &
      ;;
    konsole)
      konsole --title "$title" -e bash -lc "$inner" &
      ;;
    xfce4-terminal)
      xfce4-terminal --title="$title" -e "bash -lc $(printf '%q' "$inner")" &
      ;;
    kitty)
      kitty --title "$title" -d "$ROOT" bash -lc "$inner" &
      ;;
    alacritty)
      alacritty --title "$title" --working-directory "$ROOT" -e bash -lc "$inner" &
      ;;
    xterm)
      xterm -title "$title" -e bash -lc "$inner" &
      ;;
    foot)
      foot -T "$title" bash -lc "$inner" &
      ;;
    wezterm)
      wezterm start --cwd "$ROOT" -- bash -lc "$inner" &
      ;;
    ghostty)
      ghostty -e bash -lc "$inner" &
      ;;
    *)
      return 1
      ;;
  esac
}

try_linux_once() {
  local term="$1"
  local s1c s2c
  s1c="${SERVER_INNER}; exec bash"
  s2c="${CLIENTS_INNER}; exec bash"
  command -v "$term" >/dev/null 2>&1 || return 1
  open_linux "$term" "qwery-server" "$s1c" || return 1
  sleep 0.3
  open_linux "$term" "qwery-clients" "$s2c"
}

try_linux() {
  local term
  if [[ -n "${QWERY_DEV_TERMINAL_EMU:-}" ]]; then
    if try_linux_once "$QWERY_DEV_TERMINAL_EMU"; then
      return 0
    fi
    echo "open-dev-terminals: QWERY_DEV_TERMINAL_EMU=${QWERY_DEV_TERMINAL_EMU} failed or unsupported; falling back." >&2
  fi
  for term in gnome-terminal konsole xfce4-terminal kitty alacritty foot wezterm ghostty xterm; do
    if try_linux_once "$term"; then
      return 0
    fi
  done
  return 1
}

print_manual() {
  echo "Run in two terminals from the repo root:" >&2
  echo "  1: $SERVER_CMD" >&2
  if [[ ${#CLIENT_ARGS[@]} -gt 0 ]]; then
    echo "  2: pnpm run $RUN_NAME -- $(printf '%q ' "${CLIENT_ARGS[@]}")" >&2
  else
    echo "  2: pnpm run $RUN_NAME" >&2
  fi
  echo "  (Child cleanup + Portless env live in scripts/run-dev-clients.sh — use that script via pnpm or: bash scripts/run-dev-clients.sh $MODE ...)" >&2
}

qwery_in_vscode_terminal() {
  [[ -n "${VSCODE_IPC_HOOK_CLI:-}" ]] ||
    [[ -n "${VSCODE_IPC_HOOK:-}" ]] ||
    [[ "${TERM_PROGRAM:-}" == "vscode" ]] ||
    [[ "${TERM_PROGRAM:-}" == "vscode-insiders" ]] ||
    [[ -n "${CURSOR_TRACE_ID:-}" ]]
}

qwery_should_use_vscode_tasks() {
  case "${QWERY_DEV_TERMINAL_UI:-auto}" in
    vscode) return 0 ;;
    external) return 1 ;;
    auto)
      qwery_in_vscode_terminal && return 0
      return 1
      ;;
    *)
      return 1
      ;;
  esac
}

qwery_vscode_task_label() {
  local mode=$1
  shift
  local joined
  joined=$(IFS=' '; echo "$*")
  if [[ -z "$joined" ]]; then
    if [[ "$mode" == "portless" ]]; then
      printf '%s' "Qwery: dev - server + clients (portless)"
    else
      printf '%s' "Qwery: dev - server + clients (regular)"
    fi
    return 0
  fi
  case "$mode:$joined" in
    regular:web)
      printf '%s' "Qwery: dev - server + clients (regular, web only)"
      ;;
    portless:web)
      printf '%s' "Qwery: dev - server + clients (portless, web only)"
      ;;
    regular:all)
      printf '%s' "Qwery: dev - server + clients (regular, all clients)"
      ;;
    portless:all)
      printf '%s' "Qwery: dev - server + clients (portless, all clients)"
      ;;
    *)
      return 1
      ;;
  esac
  return 0
}

qwery_emit_vscode_hint() {
  local label
  if label=$(qwery_vscode_task_label "$MODE" "${CLIENT_ARGS[@]}"); then
    echo ""
    echo "VS Code / Cursor: use integrated terminals (see .vscode/tasks.json)."
    echo "  Command Palette → Tasks: Run Task → ${label}"
    echo "  (Two dedicated terminal panels. In Cursor, Ctrl+Shift+B may open a browser instead.)"
    echo ""
  else
    echo "No predefined VS Code task for this client combination." >&2
    print_manual
  fi
}

if qwery_should_use_vscode_tasks; then
  qwery_emit_vscode_hint
  exit 0
fi

case "$(uname -s)" in
  Darwin)
    open_macos
    ;;
  Linux)
    if ! try_linux; then
      echo "No supported terminal emulator found (tried gnome-terminal, konsole, xfce4-terminal, kitty, alacritty, foot, wezterm, ghostty, xterm). Set QWERY_DEV_TERMINAL_EMU to a known name or run the printed commands manually." >&2
      print_manual
      exit 1
    fi
    ;;
  *)
    echo "Unsupported OS." >&2
    print_manual
    exit 1
    ;;
esac
