#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# This script only deploys the independent Everstate demo, never the earlier prototypes.
server="root@89.167.19.222"
remote_dir="/opt/everstate-knowledge-base"
npm run check
npm run build:web
ssh "$server" "mkdir -p '$remote_dir/data' '$remote_dir/artifacts' '$remote_dir/Costs'"
rsync -az --exclude=.git --exclude=node_modules --exclude=data --exclude=.env --exclude=claude-work --exclude=codex-work ./ "$server:$remote_dir/"
if [ -d data/youtube ]; then rsync -az data/youtube/ "$server:$remote_dir/data/youtube/"; fi
rsync -az .env "$server:$remote_dir/.env"
ssh "$server" "chmod 600 '$remote_dir/.env'"
# Bootstrap data is transferred only when no live database exists. Subsequent deploys retain live costs/data.
if ! ssh "$server" "test -f '$remote_dir/data/knowledge.sqlite'"; then
  snapshot_path="data/deploy-snapshot-$(date +%s).sqlite"
  npx tsx scripts/backup-database.ts "$snapshot_path"
  rsync -az "$snapshot_path" "$server:$remote_dir/data/knowledge.sqlite"
fi
code_version=$(git rev-parse HEAD)
ssh "$server" "cd '$remote_dir' && CODE_VERSION='$code_version' docker compose up -d --build"
ssh "$server" "curl --fail --retry 10 --retry-all-errors --retry-delay 2 http://127.0.0.1:4318/health"
