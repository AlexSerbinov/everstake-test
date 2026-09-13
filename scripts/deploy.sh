#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Build only the recorded commit; another publisher cannot change this build context.
server="root@89.167.19.222"
remote_dir="/opt/everstate-knowledge-base"
code_version=$(git rev-parse HEAD)
image="everstate-knowledge-base-knowledge:$code_version"
if ! git diff --quiet HEAD -- src web public config prompts scripts package.json package-lock.json; then
  echo "Commit and verify runtime changes before deployment." >&2
  exit 1
fi
ssh "$server" "test -f '$remote_dir/.env'"
npm run check
git archive "$code_version" | ssh "$server" "docker build -t '$image' -"
ssh "$server" "docker run --rm --cpus=2 '$image' npm run check"
# Preserve the serving database and credentials; publish only immutable artifacts/config.
ssh "$server" "mkdir -p '$remote_dir/data' '$remote_dir/artifacts' '$remote_dir/costs'"
git archive "$code_version" compose.yaml artifacts costs | ssh "$server" "tar -xf - -C '$remote_dir'"
if ! ssh "$server" "test -f '$remote_dir/data/knowledge.sqlite'"; then
  snapshot_path="data/deploy-snapshot-$(date +%s).sqlite"
  npx tsx scripts/backup-database.ts "$snapshot_path"
  rsync -az "$snapshot_path" "$server:$remote_dir/data/knowledge.sqlite"
fi
ssh "$server" "cd '$remote_dir' && CODE_VERSION='$code_version' docker compose -f compose.yaml -f - up -d --no-build knowledge" <<YAML
services:
  knowledge:
    image: $image
YAML
ssh "$server" "docker exec everstate-knowledge-base npx tsx scripts/import-evaluations.ts"
ssh "$server" "docker exec everstate-knowledge-base npx tsx scripts/import-mcp-measurements.ts artifacts/mcp/measurements-2026-09-13.json"
ssh "$server" "curl --fail --retry 10 --retry-all-errors --retry-delay 2 http://127.0.0.1:4318/health"
