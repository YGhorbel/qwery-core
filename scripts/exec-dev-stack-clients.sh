#!/usr/bin/env bash
set -euo pipefail

ROOT="$1"
RUN="$2"
shift 2
cd "$ROOT" || exit 1
exec pnpm run "$RUN" -- "$@"
