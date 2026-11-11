/**
 * Headless Keel: runs the same MCP server + TurnRunner the extension uses, against a folder on disk.
 * Used for E2E tests and for debugging the agent loop without VS Code.
 *
 *   npx tsx src/node/headless.ts --root ../flask --model mock/edit-helpers "Treat 'off' and 'n' as false"
 *   npx tsx src/node/headless.ts --root ../flask --agent keel-agent "..."   (saved agent, as the extension does)
 */
import { NodeHost } from './nodeHost';
import { startMcpServer } from '../core/mcp/server';
import { AutoAcceptGate } from '../core/review/gate';
import { createClient, registerMcpServer } from '../core/trueforge/client';
import { runRequest } from '../core/trueforge/turnRunner';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

async function main() {
  const root = arg('root');
  const agentName = arg('agent', '');
  const model = agentName ? '' : arg('model');
  const tf = arg('trueforge', 'http://localhost:8790');
  const mcpName = arg('mcp-name', agentName ? 'keel-editor' : 'keel-headless');
  const request = process.argv[process.argv.length - 1];

  const host = new NodeHost(root, m => console.error(`[host] ${m}`));
  const mcp = await startMcpServer({
    host,
    gate: new AutoAcceptGate(),
    events: {
      onToolCall: (n, a) => console.log(`\n[tool] ${n} ${JSON.stringify(a).slice(0, 160)}`),
      onFileWritten: (p, ok, rej) => console.log(`[write] ${p} applied=${ok.map(i => i + 1)} rejected=${rej.map(i => i + 1)}`),
    },
  });
  await registerMcpServer(tf, mcpName, mcp.url, mcp.token);
  console.log(`[keel] MCP ${mcp.url} registered as ${mcpName}`);

  const client = createClient(tf);
  const { data: session } = await client.sessions.create({
    agent: agentName ? { name: agentName } : {
      spec: {
        model: { name: model },
        instructions: 'You are Keel, a coding agent. Read before you write. Edit with propose_edit.',
        mcp_servers: [{ name: mcpName, preload: true, require_approval_for_tools: ['propose_edit', 'create_file'] }],
        config: { iteration_limit: 30 },
      },
    },
  } as never);
  console.log(`[keel] session ${session.id}`);

  const outcome = await runRequest(client, session.id, request, {
    onText: (t, thread) => {
      if (!thread || thread === 'main') process.stdout.write(t);
    },
    onEvent: ev => {
      if (ev.type === 'tool.approval_required') console.log('\n[keel] approval required');
    },
    onApproval: async calls => {
      for (const c of calls) console.log(`[keel] auto-approving ${c.toolName}`);
      return calls.map(() => ({ status: 'allow' as const }));
    },
  });
  console.log(`\n[keel] outcome: ${JSON.stringify(outcome)}`);
  await mcp.close();
  process.exit(outcome.status === 'done' ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
