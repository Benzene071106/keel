#!/usr/bin/env bash
# Start TrueForge in local mode with loopback allowed.
# TrueForge's outbound URL guard blocks 127.0.0.1/localhost by default, which would
# block both Keel's in-editor MCP server and local models (Ollama, vLLM, the mock model).
set -euo pipefail
export OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'
exec npx @truefoundry/trueforge@latest --port "${TRUEFORGE_PORT:-8790}"
