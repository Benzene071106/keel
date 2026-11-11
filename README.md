# Keel

A VS Code coding agent whose agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge).
Keel's editor (read, search, propose edits) is exposed to the agent as MCP tools; every write is
gated by TrueForge tool approval and reviewed hunk by hunk.

> Status: build steps 1-7 done (TrueForge loop, MCP tools, approval-driven per-hunk review, run journal
> and undo, inline edit, cancel-safe runs). Context engine and model fallback are next. Starting point: **from scratch**
> (no upstream fork).

## How review works

Write tools (`propose_edit`, `create_file`) are gated by TrueForge tool approval. When a turn pauses,
Keel opens a read-only review document per file: each hunk shows its removed lines (red) and added lines
(green) with **Accept / Reject** CodeLens buttons. Press **Done reviewing** (Ctrl/Cmd+Enter) and Keel
answers TrueForge: allow if at least one hunk was accepted, deny with a reason otherwise. When TrueForge
then runs the tool, Keel's MCP server writes **only the accepted hunks**, in one `WorkspaceEdit`
(Ctrl/Cmd+Z undoes it), and tells the model which hunks were rejected. **Keel: Undo Last Run** restores
every file the run touched. A tool call without a recorded decision, or arriving after Stop, writes
nothing.

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

### Inline edit

Select code, press **Ctrl+Alt+K** (Cmd+Alt+K on macOS), type an instruction. Tokens stream into a preview
beside the editor (Esc cancels; nothing is changed). The proposal then opens in the per-hunk review.
Runs on the `keel-inline` TrueForge agent.

### Headless run (no VS Code)

Runs the same MCP server and turn loop against a folder on disk:

```bash
cd extension
npx tsx src/node/headless.ts --root /path/to/flask --agent keel-agent "Treat 'off' and 'n' as false"
npx tsx src/node/headlessInline.ts --root /path/to/flask --file src/flask/helpers.py --lines 28-33 "instruction"
```

With the mock model, pick scenarios per agent: `KEEL_PRIMARY_MODEL=mock/edit-helpers KEEL_MODEL_KEEL_INLINE=mock/inline-debug-flag node scripts/sync-agents.mjs`.

## Cancellation guarantee

Stop (`Keel: Stop`, or Esc during inline edit) calls TrueForge `sessions.cancel`, rejects any open review,
and clears pending decisions, so a tool call that arrives later writes nothing. Each file write is a single
atomic replace. After Stop, every file is either untouched or completely updated, and Keel offers
**Revert run**. `scripts/chaos-cancel.mjs` checks this by stopping a three-file run at random moments:

```bash
KEEL_PRIMARY_MODEL=mock/slow-multi-edit node scripts/sync-agents.mjs
node scripts/chaos-cancel.mjs --root /path/to/flask --runs 30
# 30/30 consistent. untouched=10 some-files=14 all-files=6   (2026-11-11)
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
