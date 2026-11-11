#!/usr/bin/env bash
# One-shot dev setup once TrueForge is running (./scripts/start-trueforge.sh in another terminal):
# starts the mock model if needed, registers it, creates the Keel agents, builds the extension.
set -euo pipefail
cd "$(dirname "$0")/.."
TF="${TRUEFORGE_URL:-http://localhost:8790}"
PORT="${MOCK_MODEL_PORT:-7802}"

echo "== 1/4 TrueForge at $TF"
curl -s -o /dev/null "$TF/api/v1/agents?limit=1" || { echo "TrueForge is not running. In another terminal: ./scripts/start-trueforge.sh" >&2; exit 1; }

echo "== 2/4 mock model on :$PORT"
if curl -s -o /dev/null "http://127.0.0.1:$PORT/v1/models" 2>/dev/null || curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
  echo "already running"
else
  nohup node dev/mock-model/server.mjs > mock-model.log 2>&1 &
  sleep 1
  echo "started (log: mock-model.log)"
fi
./dev/register-mock-model.sh

echo "== 3/4 Keel agents"
node scripts/sync-agents.mjs --mock

echo "== 4/4 build extension"
cd extension
npm install --no-audit --no-fund
npm run build
echo
echo "Done. Open the extension folder in VS Code (code extension) and press F5."
