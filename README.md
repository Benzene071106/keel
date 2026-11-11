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
node scripts/sync-agents.mjs --mock      # or: --primary <provider/model> --fallback <provider/model>

# 4. Build the extension, then press F5 in VS Code on the extension/ folder
cd extension && npm install && npm run build
```

In the Extension Development Host, open a repository (e.g. Flask at tag 3.1.3), click the Keel icon in
the activity bar and type a task in the Agent panel (or run **Keel: Run Agent Task**). The panel shows the
timeline, the Context Ledger, changed files, Stop and Undo run. A raw log goes to the "Keel" output channel.

No debugger needed: `code --extensionDevelopmentPath=/path/to/keel/extension /path/to/flask` does the same as F5.

### Install as a normal extension

```bash
cd extension && npm install && npm run package     # writes extension/keel.vsix
code --install-extension keel.vsix
```

Then open any repository in VS Code and click the Keel icon in the activity bar.

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

## How context is chosen (Context Ledger)

The agent's first call is `context_pack(request)`. Keel ranks files with signals it can explain,
packs them under a token budget, and tells the model (and you, in the Keel output channel) why
each file is there:

- **Lexical**: BM25 over code symbols (name, signature, docstring) and doc sections.
- **Named module**: the request says "cli" or "config", so `cli.py` and `config.py` get a boost.
- **Mentions**: `@path` or `@symbol` you typed.
- **Tests by convention**: `tests/test_x.py`, `x.test.ts`, and so on.
- **Docs that reference the code**: Sphinx roles, `autofunction`, ``name()`` literals.
- **Git co-change**: files committed together with the seeds, as P(other | seed). Commits that touch more than 30 files are ignored.
- **Registration sites**: where in the same file a chosen symbol is used, e.g. `FlaskGroup.__init__` calls `add_command(shell_command)`.

Each expansion signal counts once per file, from its strongest seed, so hubs like `CHANGES.rst` don't
win just by touching everything. Each file degrades `full → symbols/sections → outline → path`
before it is dropped. Dropped files are listed too.

On Flask with the Task B request, the index builds in about 0.35 s. The pack takes about 30 ms and uses 7.4k of 12k tokens, and it
includes `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst` and `CHANGES.rst`, each with its
reasons. Also available: `find_symbol` and `repo_map`.

## When a model fails (Task C)

TrueForge has no model fallback. It retries only connect timeouts and 408/429/503, twice. Keel's
`runWithFailover` (`extension/src/core/trueforge/failover.ts`) adds the rest:

| Failure | What Keel does |
| --- | --- |
| 401/403/404, connection refused, DNS | Fatal for that model: switch to the fallback agent at once |
| 408/429/5xx, timeout, reset | Retry on the same session (2 tries, backoff), then switch |
| Anything that is not a model error | Shown to you; no switch |

A fallback never replays blindly. If files were already changed and accepted, the fallback model gets
the request plus the list of changed files and is told not to redo them. The status bar shows which
agent is serving, and turns amber after a switch. Inline edit uses the same policy.

Reproduce with the mock model:

```bash
cd extension
npx tsx src/node/headless.ts --root ../flask --model mock/fail-401 --fallback-model mock/edit-helpers "..."
npx tsx src/node/headless.ts --root ../flask --model mock/midrun-fail --fallback-model mock/resume "..."
npx tsx src/node/headless.ts --root ../flask --model mock/flaky --fallback-model mock/resume "..."
```

## Running commands

`run_command` lets the agent run the tests it wrote. Every command passes three checks:

| Class | Examples | What happens |
| --- | --- | --- |
| Allowlist | `pytest`, `python -m pytest`, `git status/diff/log`, `npm test`, `tsc`, `ruff` | Runs at once |
| Everything else | `pip install x`, `make docs` | You are asked first |
| Blocklist | `rm -rf`, `sudo`, `git push`, `git reset --hard`, `curl ... \| sh`, anything touching `.ssh` / `.env` | Never runs |

A command with `;`, `&&`, `|`, `$(...)` or redirection is never treated as allowlisted. The MCP tool only
executes a command that was approved for this run (fail closed). Output streams into a "Keel" terminal,
the model gets the last 12k characters and the exit code, and Stop kills the whole process tree.

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
