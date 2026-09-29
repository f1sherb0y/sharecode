#!/usr/bin/env bash
# Playwright runs under Node; Bun only transpiles the TypeScript fixture.
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir/frontend"
mkdir -p node_modules/.cache
test_dir="$(mktemp -d "$PWD/node_modules/.cache/sharecode-export.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT
bun build tests/session-export-browser.ts --target=node --packages=external \
  --outfile="$test_dir/session-export.mjs"
node "$test_dir/session-export.mjs"
