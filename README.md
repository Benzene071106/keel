# Keel

A VS Code coding agent whose agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge).
Keel's editor (read, search, propose edits) is exposed to the agent as MCP tools; every write is
gated by TrueForge tool approval and reviewed hunk by hunk.

> Status: walking skeleton (build steps 1-4). Per-hunk review UI, inline edit, context engine and
> model fallback are next. Starting point: **from scratch** (no upstream fork).

## Quick start (development)

Requirements: Node 22.14+, git, ripgrep (`rg`) on PATH for headless runs.

```bash
# 1. Start TrueForge in local mode. Loopback must be allowed, or TrueForge refuses
#    Keel's localhost MCP server and any local model ("Outbound URL blocked for host 127.0.0.1").
./scripts/start-trueforge.sh            # = OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest

# 2. Configure a model in TrueForge (Settings -> Models), or use the scripted mock model (no API key):
node dev/mock-model/server.mjs &        # OpenAI-compatible mock on 127.0.0.1:7802
./dev/register-mock-model.sh            # registers provider "mock" with one model per scenario

# 3. Create the Keel agents (keel-agent and keel-agent-fallback)
KEEL_PRIMARY_MODEL=mock/edit-helpers KEEL_FALLBACK_MODEL=mock/edit-helpers node scripts/sync-agents.mjs

# 4. Build the extension, then press F5 in VS Code on the extension/ folder
cd extension && npm install && npm run build
```

In the Extension Development Host, open a repository (e.g. Flask at tag 3.1.3) and run
**Keel: Run Agent Task**. Output streams to the "Keel" output channel.

### Headless run (no VS Code)

Runs the same MCP server and turn loop against a folder on disk:

```bash
cd extension
npx tsx src/node/headless.ts --root /path/to/flask --agent keel-agent "Treat 'off' and 'n' as false"
```

## Layout

| Path | What |
|---|---|
| `extension/src/core/` | editor-agnostic core: MCP server and tools, hunk review, TrueForge client and turn loop |
| `extension/src/vscode/` | VS Code adapter (`EditorHost` on the VS Code API) and extension entry point |
| `extension/src/node/` | Node adapter (`EditorHost` on fs) and the headless runner |
| `agents/` | TrueForge agent definitions; `scripts/sync-agents.mjs` creates them |
| `dev/mock-model/` | scripted OpenAI-compatible model for deterministic tests |
| `spikes/` | Day-0 feasibility spike and findings |

## Models

No API keys are committed. Configure models in TrueForge; Keel never calls a model provider directly.
