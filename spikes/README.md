# Day-0 spike: can TrueForge drive a localhost MCP tool loop?

Result (2026-11-11, TrueForge v0.184.2): **yes, once loopback is allowed.**

- `spike.mjs` runs a streamable-HTTP MCP server (`hello` tool, bearer auth) on 127.0.0.1:7801
  and a mock OpenAI-compatible model on 127.0.0.1:7802 that calls `hello`, then answers.
- `run-turn.mjs <model> [gate]` creates a session with an inline agent spec and streams a turn.
  With `gate`, the tool pauses on `tool.approval_required`; the script approves and resumes.

Findings:
1. Default `npx @truefoundry/trueforge` rejects `http://127.0.0.1` for both MCP servers and model
   providers: `Outbound URL blocked for host "127.0.0.1"`. Fix: start with
   `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'` (see `scripts/start-trueforge.sh`).
2. Preloaded MCP tools reach the model under their own name (`hello`). Built-in harness tools
   also present: ask_user_question, get_current_datetime, call_tool, get_tool_info,
   get_tool_output_schema, list_tools, get_openui_instructions, create_sub_agent.
3. Approval flow works end to end: turn 1 ends with `tool.approval_required`; turn 2 with
   `user.tool_approval` runs the tool and the model's reply streams as deltas.
4. Unreachable model (ECONNREFUSED) ends the turn in ~0.3 s with
   `turn.done {status:"error", message:"[Model Error] Cannot connect to API: connect ECONNREFUSED ..."}`.
   No harness-level fallback; transport retries apply only to connect timeouts and 408/429/503-style statuses.
