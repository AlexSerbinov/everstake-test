#!/usr/bin/env bash
# Deploy to the demo host: rsync code + built index, build the image there, (re)start,
# make sure Caddy has a site block, then health-check through the public URL.
#
#   ./scripts/deploy.sh            # uses defaults below
#   HOST=root@1.2.3.4 ./scripts/deploy.sh
set -euo pipefail

HOST="${HOST:-root@89.167.19.222}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_rsa}"
REMOTE_DIR="${REMOTE_DIR:-/opt/everstake-kb}"
REMOTE_DATA="${REMOTE_DATA:-/data/everstake-kb}"        # big disk on the host
DOMAIN="${DOMAIN:-everstake.89-167-19-222.sslip.io}"
PORT="${PORT:-4320}"
SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new $HOST"

cd "$(dirname "$0")/.."
[ -f data/kb.db ] || { echo "data/kb.db missing — run: npm run pipeline"; exit 1; }
[ -f .env ] || { echo ".env missing"; exit 1; }

echo "▶ sync code → $HOST:$REMOTE_DIR"
$SSH "mkdir -p $REMOTE_DIR $REMOTE_DATA"
rsync -az --delete -e "ssh -i $SSH_KEY" \
  --exclude .git --exclude node_modules --exclude dist --exclude data --exclude reference --exclude '*.log' \
  ./ "$HOST:$REMOTE_DIR/"

echo "▶ sync index → $REMOTE_DATA/kb.db  ($(du -h data/kb.db | cut -f1))"
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/kb.db');d.exec('PRAGMA wal_checkpoint(TRUNCATE)');d.close()"   # fold the WAL into the main file
$SSH "docker stop everstake-kb >/dev/null 2>&1 || true; rm -f $REMOTE_DATA/kb.db-wal $REMOTE_DATA/kb.db-shm"   # never copy over a live DB or leave a stale WAL next to the new file
rsync -rltz --no-owner --no-group -e "ssh -i $SSH_KEY" data/kb.db "$HOST:$REMOTE_DATA/kb.db"   # /data pool refuses chown

echo "▶ build + start container"
$SSH "cd $REMOTE_DIR && KB_DATA_DIR=$REMOTE_DATA docker compose up -d --build --remove-orphans 2>&1 | tail -3"

echo "▶ caddy site block for $DOMAIN"
$SSH "grep -q '^$DOMAIN' /etc/caddy/Caddyfile || { printf '\n%s {\n    reverse_proxy localhost:%s\n}\n' '$DOMAIN' '$PORT' >> /etc/caddy/Caddyfile && systemctl reload caddy && echo added; }"

echo "▶ health check"
for i in $(seq 1 20); do
  if curl -fsS "https://$DOMAIN/health" >/dev/null 2>&1; then echo "✓ https://$DOMAIN is up"; curl -s "https://$DOMAIN/api/stats" | head -c 300; echo; exit 0; fi
  sleep 3
done
echo "✗ not healthy yet — check: $SSH 'docker logs everstake-kb --tail 50'"; exit 1
