#!/usr/bin/env bash
# Produce the reference outputs for the parity tests with the Python CLI in fast mode:
# every fixture in tests/fixtures/ against tiny.ttl and PMDco 3.1.1, saved as JSON,
# Markdown, terminal text and the generated OWL (Turtle) under web/tests/golden/fast/.
#
# Run from web/ after `npm run fetch-pmdco`, with the Python tool installed in web/.venv
# (python3 -m venv .venv && .venv/bin/pip install -e ..).
set -euo pipefail
cd "$(dirname "$0")/.."

CLI=${MERMANTICS_CLI:-.venv/bin/mermantics}
OUT=tests/golden/fast
PMDCO=.cache/pmdco-full-3.1.1.ttl
# Python's set order depends on the string hash seed; fix it so reruns give the same files.
export PYTHONHASHSEED=0

[ -f "$PMDCO" ] || { echo "missing $PMDCO, run: npm run fetch-pmdco" >&2; exit 2; }
mkdir -p "$OUT"
for diagram in ../tests/fixtures/*.mmd; do
  name=$(basename "$diagram" .mmd)
  for onto in tiny pmdco; do
    if [ "$onto" = tiny ]; then source=../tests/fixtures/tiny.ttl; else source=$PMDCO; fi
    base="$OUT/$name.$onto"
    echo "$base"
    # Exit code 1 only means that errors were found.
    "$CLI" "$diagram" -o "$source" --fast --json "$base.json" --report "$base.md" --emit-owl "$base.ttl" > "$base.txt" || [ $? -eq 1 ]
  done
done
