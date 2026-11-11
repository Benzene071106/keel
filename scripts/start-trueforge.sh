#!/usr/bin/env bash
# Start TrueForge in local mode with loopback allowed.
# TrueForge's outbound URL guard blocks 127.0.0.1/localhost by default, which would
# block both Keel's in-editor MCP server and local models (Ollama, vLLM, the mock model).
set -euo pipefail
# Hosted OpenAI-compatible providers registered as "custom" are listed too, in case the guard checks them.
export OUTBOUND_URL_ALLOWED_HOSTS="${OUTBOUND_URL_ALLOWED_HOSTS:-[\"127.0.0.1\",\"localhost\",\"api.groq.com\",\"openrouter.ai\"]}"
exec npx @truefoundry/trueforge@latest --port "${TRUEFORGE_PORT:-8790}"
