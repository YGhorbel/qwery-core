#!/usr/bin/env bash
# Install workspace tasks for VS Code / Cursor (see docs/portless-local-dev.md).
# .vscode/ is gitignored; this copies the committed template into your checkout.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/tooling/vscode/tasks.json"
DEST="$ROOT/.vscode/tasks.json"

if [[ ! -f "$SRC" ]]; then
  echo "Missing template: $SRC" >&2
  exit 1
fi

mkdir -p "$ROOT/.vscode"
cp "$SRC" "$DEST"
echo "Installed: $DEST"
echo "In VS Code / Cursor: Command Palette → Tasks: Run Task → pick a \"Qwery: dev - …\" task."
