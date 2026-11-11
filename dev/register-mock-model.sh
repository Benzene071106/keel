#!/usr/bin/env bash
# Register the scripted mock model (dev/mock-model) in TrueForge as provider "mock".
# One TrueForge model per scenario file, plus failure models for resilience tests.
set -euo pipefail
TF="${TRUEFORGE_URL:-http://localhost:8790}"
PORT="${MOCK_MODEL_PORT:-7802}"
dir="$(cd "$(dirname "$0")/mock-model/scenarios" && pwd)"
models=""
for f in "$dir"/*.json; do
  n="$(basename "$f" .json)"
  for id in "$n" "slow-$n"; do
    models+="{\"model_id\":\"$id\",\"name\":\"$id\",\"properties\":{\"context_length\":128000,\"max_output_tokens\":8192}},"
  done
done
for id in fail-401 fail-500; do
  models+="{\"model_id\":\"$id\",\"name\":\"$id\",\"properties\":{\"context_length\":128000,\"max_output_tokens\":8192}},"
done
curl -sf -X PUT "$TF/api/v1/settings/model-providers" -H 'content-type: application/json' \
  -d "{\"manifest\":{\"type\":\"custom\",\"name\":\"mock\",\"base_url\":\"http://127.0.0.1:$PORT/v1\",\"auth\":{\"api_key\":\"mock\"},\"models\":[${models%,}]}}" >/dev/null
echo "registered mock models: $(echo "$models" | grep -o '"name":"[^"]*"' | cut -d'"' -f4 | tr '\n' ' ')"
