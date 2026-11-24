#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
bridge_node="${BRIDGE_NODE:-node}"
if [[ -x .runtime/node-v24.11.1-darwin-arm64/bin/node ]]; then
  bridge_node="$PWD/.runtime/node-v24.11.1-darwin-arm64/bin/node"
fi
if [[ "$("$bridge_node" -p "process.versions.node.split('.')[0]")" != "24" ]]; then
  echo 'Install Node.js 24 LTS, or set BRIDGE_NODE to its executable.' >&2
  exit 1
fi
exec "$bridge_node" src/cli.cjs --config config.json "$@"
