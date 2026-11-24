#!/usr/bin/env bash

set -euo pipefail

# ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required to run the development environment." >&2
  exit 1
fi

# The electron package downloads its binary on first use; fetch it first so
# the path below is the only output.
npx --no install-electron >&2

# Resolve the Electron binary via Node to avoid Bun resolution hiccups
ELECTRON_EXEC_PATH="$(node -p "require('electron')")"

if [[ -z "${ELECTRON_EXEC_PATH}" ]]; then
  echo "Failed to resolve the Electron binary path." >&2
  exit 1
fi

export NODE_ENV="${NODE_ENV:-development}"
export ELECTRON_EXEC_PATH

# ELECTRON_VITE_BIN="$ROOT_DIR/node_modules/.bin/electron-vite"

if [[ ! -x "${ELECTRON_VITE_BIN}" ]]; then
  echo "electron-vite binary not found. Have you installed dependencies?" >&2
  exit 1
fi

exec "${ELECTRON_VITE_BIN}" dev "$@"
