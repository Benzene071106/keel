import * as vscode from 'vscode';
import { startMcpServer, type RunningMcpServer } from '../core/mcp/server';
import { ContextService } from '../core/context/service';
import { gitIndexSources } from '../node/indexSources';
import { DecisionLedger } from '../core/review/ledger';
import { JournaledHost } from '../core/review/journal';
import { EditorReviewer } from './review';
import { createClient, registerMcpServer } from '../core/trueforge/client';
import { runWithFailover, withInlineFailover } from '../core/trueforge/failover';
import { runInline } from '../core/inline/runInline';
import { VscodeHost } from './vscodeHost';
import { registerInlineEdit } from './inline';

let mcp: RunningMcpServer | undefined;
let currentSessionId: string | undefined;
let stopRequested = false;

function cfg<T>(key: string): T {
  return vscode.workspace.getConfiguration('keel').get<T>(key) as T;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const out = vscode.window.createOutputChannel('Keel');
  context.subscriptions.push(out);
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    out.appendLine('Keel: open a folder to use the agent.');
    return;
  }
  const host = new JournaledHost(new VscodeHost(folder.uri.fsPath, out));
  const reviewer = new EditorReviewer();
  context.subscriptions.push(reviewer);
  const ledger = new DecisionLedger(host, reviewer, {
    ask: async cmd => {
      const pick = await vscode.window.showWarningMessage(`Keel wants to run: ${cmd}`, { modal: true }, 'Run');
      return pick === 'Run' ? { status: 'allow' } : { status: 'deny', reason: 'The user declined to run this command.' };
    },
  });
  const baseUrl = cfg<string>('trueforgeUrl');
  const client = createClient(baseUrl);

  const ready = (async () => {
    const contextService = new ContextService(gitIndexSources(folder.uri.fsPath));
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => contextService.invalidate()));
    mcp = await startMcpServer({
      host,
      gate: ledger,
      context: contextService,
      events: {
        onContextPack: p => {
          out.appendLine(`◆ context pack: ${p.items.length} files, ${p.used}/${p.budget} tokens, ${p.ms} ms`);
          for (const i of p.items) out.appendLine(`   ${i.score.toFixed(2)} ${i.path} [${i.granularity}] ${i.reasons.join('; ')}`);
          if (p.dropped.length) out.appendLine(`   left out: ${p.dropped.map(d => d.path).join(', ')}`);
        },
        onToolCall: (name, args) => out.appendLine(`\n▸ ${name} ${JSON.stringify(args).slice(0, 200)}`),
        onFileWritten: (p, ok, rej) => out.appendLine(`✎ ${p}: applied ${ok.length} hunk(s), rejected ${rej.length}`),
      },
    });
    await registerMcpServer(baseUrl, cfg<string>('mcpServerName'), mcp.url, mcp.token);
    out.appendLine(`Keel MCP server ${mcp.url} registered with TrueForge at ${baseUrl}`);
  })().catch(err => {
    out.appendLine(`Keel could not connect to TrueForge: ${String(err.message ?? err)}`);
    void vscode.window.showErrorMessage(`Keel: ${String(err.message ?? err)}`);
  });

  const modelStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  modelStatus.tooltip = 'Model agent serving the current Keel run';
  context.subscriptions.push(modelStatus);

  registerInlineEdit(context, {
    client,
    host,
    reviewer,
    out,
    agentName: () => cfg<string>('inlineAgent'),
    run: (req, hooks) =>
      withInlineFailover(
        [cfg<string>('inlineAgent'), cfg<string>('inlineFallbackAgent')].filter((n, i, all) => n && all.indexOf(n) === i),
        agent => runInline(client, agent, req, hooks),
        (from, to, reason) => out.appendLine(`⇄ inline: ${from} → ${to}: ${reason}`),
      ),
  });

  context.subscriptions.push(
    { dispose: () => void mcp?.close() },
    vscode.commands.registerCommand('keel.agent.run', async () => {
      await ready;
      const request = await vscode.window.showInputBox({ prompt: 'What should Keel do?', ignoreFocusOut: true });
      if (!request) return;
      out.show(true);
      out.appendLine(`\n=== ${request}`);
      stopRequested = false;
      modelStatus.backgroundColor = undefined;
      host.beginRun();
      ledger.begin();
      try {
        const names = [cfg<string>('agent'), cfg<string>('fallbackAgent')].filter((n, i, all) => n && all.indexOf(n) === i);
        const outcome = await runWithFailover(
          client,
          request,
          {
            onText: (t, thread) => {
              if (!thread || thread === 'main') out.append(t);
            },
            onApproval: calls => ledger.onApproval(calls),
          },
          () => stopRequested,
          {
            targets: names.map(name => ({ label: name, createSession: async () => (await client.sessions.create({ agent: { name } })).data.id })),
            changedFiles: () => host.touched.map(c => c.path),
            onSession: (id, label) => {
              currentSessionId = id;
              modelStatus.text = `$(hubot) Keel: ${label}`;
              modelStatus.show();
            },
            onRetry: r => out.appendLine(`\n⟳ ${r.target}: transient model error, retry ${r.attempt} in ${r.delayMs} ms (${r.reason})`),
            onSwitch: sw => {
              out.appendLine(`\n⇄ switching ${sw.from} → ${sw.to}: ${sw.reason}`);
              modelStatus.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
              void vscode.window.showWarningMessage(`Keel: ${sw.from} failed (${sw.reason}). Continuing on ${sw.to}.`);
            },
          },
        );
        if (outcome.status === 'error') void vscode.window.showErrorMessage(`Keel: ${outcome.message}`);
        out.appendLine(`\n=== ${outcome.status}${outcome.status === 'error' ? `: ${outcome.message}` : ''}`);
        const touched = host.touched.map(c => c.path);
        if (touched.length) out.appendLine(`Changed this run: ${touched.join(', ')}  (Keel: Undo Last Run reverts them)`);
        if (outcome.status === 'cancelled') {
          const msg = touched.length
            ? `Keel stopped. ${touched.length} file(s) were fully updated before Stop; nothing is half-applied.`
            : 'Keel stopped. No files were changed.';
          const pick = await vscode.window.showInformationMessage(msg, ...(touched.length ? ['Keep', 'Revert run'] : []));
          if (pick === 'Revert run') await vscode.commands.executeCommand('keel.run.undo');
        }
      } catch (err) {
        out.appendLine(`\n=== failed: ${String((err as Error).message ?? err)}`);
      } finally {
        currentSessionId = undefined;
      }
    }),
    vscode.commands.registerCommand('keel.agent.stop', async () => {
      stopRequested = true;
      ledger.cancel();
      reviewer.cancelAll();
      if (currentSessionId) await client.sessions.cancel(currentSessionId);
    }),
    vscode.commands.registerCommand('keel.run.undo', async () => {
      const r = await host.revertRun();
      const msg = `Keel: reverted ${r.reverted.length} file(s)${r.skipped.length ? `; left ${r.skipped.join(', ')} alone (edited since)` : ''}.`;
      out.appendLine(msg);
      void vscode.window.showInformationMessage(msg);
    }),
  );
}

export function deactivate(): Promise<void> | undefined {
  return mcp?.close();
}
