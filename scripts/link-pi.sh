#!/usr/bin/env bash
# Development only: links the installed Pi packages into node_modules so tsc,
# node --test and the harnesses resolve the same modules Pi uses at runtime.
set -euo pipefail
PI_PKG="${PI_PKG:-$(npm root -g)/@earendil-works/pi-coding-agent}"
[ -d "$PI_PKG" ] || { echo "Pi not found at $PI_PKG; set PI_PKG" >&2; exit 1; }
cd "$(dirname "$0")/.."
mkdir -p node_modules/@earendil-works
ln -sfn "$PI_PKG" node_modules/@earendil-works/pi-coding-agent
ln -sfn "$PI_PKG/node_modules/@earendil-works/pi-tui" node_modules/@earendil-works/pi-tui
ln -sfn "$PI_PKG/node_modules/typebox" node_modules/typebox
echo "linked Pi from $PI_PKG"
