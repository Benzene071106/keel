/**
 * Headless Keel: runs the same MCP server + TurnRunner the extension uses, against a folder on disk.
 * Used for E2E tests and for debugging the agent loop without VS Code.
 *
 *   npx tsx src/node/headless.ts --root ../flask --model mock/edit-helpers "Treat 'off' and 'n' as false"
 *   npx tsx src/node/headless.ts --root ../flask --agent keel-agent "..."   (saved agent, as the extension does)
 */
import { NodeHost } from './nodeHost';
import { startMcpServer } from '../core/mcp/server';
import { ContextService } from '../core/context/service';
import { gitIndexSources } from './indexSources';
import { DecisionLedger, type Reviewer } from '../core/review/ledger';
import { JournaledHost } from '../core/review/journal';
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

  // --reject "path:hunk,hunk;path2:all" rejects those hunks (1-based); everything else is accepted.
  const rejectSpec = arg('reject', '');
  const rejects = new Map<string, string[]>(
    rejectSpec ? rejectSpec.split(';').map(part => { const [p, h] = part.split(':'); return [p, (h ?? 'all').split(',')] as [string, string[]]; }) : [],
  );
  const reviewDelay = Number(arg('review-delay-ms', '0'));
  const reviewer: Reviewer = {
    async review(proposals) {
      if (reviewDelay) await new Promise(r => setTimeout(r, reviewDelay));
      return proposals.map(p => {
        const r = [...rejects.entries()].find(([k]) => p.path.endsWith(k))?.[1] ?? [];
        const accepted = p.hunks.map(h => h.index).filter(i => !(r.includes('all') || r.includes(String(i + 1))));
        console.log(`[review] ${p.path}: ${p.hunks.length} hunk(s), accepting ${accepted.map(i => i + 1).join(',') || 'none'}`);
        return { accepted, note: accepted.length < p.hunks.length ? 'headless reviewer rejected some hunks' : undefined };
      });
    },
  };
  const host = new JournaledHost(new NodeHost(root, m => console.error(`[host] ${m}`)));
  const ledger = new DecisionLedger(host, reviewer, { autoDecide: () => ({ status: 'allow' }) });
  host.beginRun();
  ledger.begin();
  const mcp = await startMcpServer({
    host,
    gate: ledger,
    context: new ContextService(gitIndexSources(root)),
    events: {
      onContextPack: p =>
        console.log(`[context] ${p.items.length} files, ${p.used}/${p.budget} tokens, ${p.ms} ms\n` + p.items.map(i => `  ${i.score.toFixed(2)} ${i.path} (${i.granularity}): ${i.reasons[0] ?? ''}`).join('\n')),
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

  let stopped = false;
  const cancelAfter = Number(arg('cancel-after-ms', '0'));
  if (cancelAfter > 0) {
    setTimeout(() => {
      stopped = true;
      ledger.cancel();
      console.log(`\n[keel] STOP after ${cancelAfter} ms`);
      void client.sessions.cancel(session.id);
    }, cancelAfter);
  }
  const outcome = await runRequest(client, session.id, request, {
    onText: (t, thread) => {
      if (!thread || thread === 'main') process.stdout.write(t);
    },
    onEvent: ev => {
      if (ev.type === 'tool.approval_required') console.log('\n[keel] approval required');
    },
    onApproval: async calls => {
      const answers = await ledger.onApproval(calls);
      calls.forEach((c, i) => console.log(`[keel] ${c.toolName} -> ${JSON.stringify(answers[i])}`));
      return answers;
    },
  }, () => stopped);
  const journalOut = arg('journal-out', '');
  if (journalOut) require('node:fs').writeFileSync(journalOut, JSON.stringify(host.touched, null, 2));
  if (process.argv.includes('--revert')) {
    const r = await host.revertRun();
    console.log(`[keel] undo run: reverted=${r.reverted.join(',')} skipped=${r.skipped.join(',')}`);
  }
  console.log(`\n[keel] outcome: ${JSON.stringify(outcome)}`);
  await mcp.close();
  process.exit(outcome.status === 'done' ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
