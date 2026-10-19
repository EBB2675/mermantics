#!/usr/bin/env bash
# Write the fixture OWL (classes plus example data) with the Python tool, for spike.mjs.
# Usage: scripts/spike/emit-owl.sh [path/to/mermantics]   (default: mermantics on PATH)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$here/../../.."
cli="${1:-mermantics}"
mkdir -p "$here/out"
for name in simulation-data-model broken-b-impossible-class broken-c-wrong-relation; do
  "$cli" "$repo/tests/fixtures/$name.mmd" --fast -q --emit-owl "$here/out/$name.ttl" > /dev/null
done
