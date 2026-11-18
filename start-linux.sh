#!/usr/bin/env bash
# Usage: ./start-linux.sh [online]
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 24 or newer is required (see https://nodejs.org or use nvm install 24)." >&2
  exit 1
fi
node scripts/check-node.mjs || exit 1
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install || exit 1
fi
exec npm start -- "$@"
