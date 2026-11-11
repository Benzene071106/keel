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
import { autoDecideCommand } from '../core/command/policy';
import { KeelPanel, contextEvent, toolSummary } from './panel';

const GATED = new Set(['propose_edit', 'create_file', 'run_command']);
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
    autoDecide: autoDecideCommand,
    ask: async cmd => {
      const pick = await vscode.window.showWarningMessage(`Keel wants to run: ${cmd}`, { modal: true }, 'Run');
      return pick === 'Run' ? { status: 'allow' } : { status: 'deny', reason: 'The user declined to run this command.' };
    },
  });
  const panel = new KeelPanel({
    run: text => void runTask(text),
    stop: () => void vscode.commands.executeCommand('keel.agent.stop'),
    undo: () => void vscode.commands.executeCommand('keel.run.undo'),
    open: (rel, line) => {
      const uri = vscode.Uri.joinPath(folder.uri, rel);
      const pos = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
      void vscode.window.showTextDocument(uri, { selection: new vscode.Range(pos, pos), preview: true });
    },
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(KeelPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } }));
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
          panel.post(contextEvent(p));
          out.appendLine(`◆ context pack: ${p.items.length} files, ${p.used}/${p.budget} tokens, ${p.ms} ms`);
          for (const i of p.items) out.appendLine(`   ${i.score.toFixed(2)} ${i.path} [${i.granularity}] ${i.reasons.join('; ')}`);
          if (p.dropped.length) out.appendLine(`   left out: ${p.dropped.map(d => d.path).join(', ')}`);
        },
        onToolCall: (name, args) => {
          // Gated tools were already shown when they paused for approval.
          if (!GATED.has(name)) panel.post({ type: 'tool', name, summary: toolSummary(name, args) });
          out.appendLine(`\n▸ ${name} ${JSON.stringify(args).slice(0, 200)}`);
        },
        onToolError: message => {
          panel.post({ type: 'toolError', message });
          out.appendLine(`  ✗ ${message}`);
        },
        onCommand: (c, r) => {
          panel.post({ type: 'tool', name: r.timedOut ? 'timed out' : `exit ${r.exitCode}`, summary: `${c} (${(r.ms / 1000).toFixed(1)} s)` });
          out.appendLine(`  exit ${r.exitCode}${r.timedOut ? ' (timed out)' : ''} in ${r.ms} ms`);
        },
        onFileWritten: (p, ok, rej) => {
          panel.post({ type: 'write', path: p, applied: ok.length, rejected: rej.length });
          out.appendLine(`✎ ${p}: applied ${ok.length} hunk(s), rejected ${rej.length}`);
        },
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

  let running = false;
  async function runTask(request: string): Promise<void> {
      if (running) {
        void vscode.window.showInformationMessage('Keel is already running a task. Stop it first.');
        return;
      }
      running = true;
      await ready;
      out.appendLine(`\n=== ${request}`);
      panel.post({ type: 'start', request });
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
              if (!thread || thread === 'main') {
                out.append(t);
                panel.post({ type: 'text', chunk: t });
              }
            },
            onApproval: async calls => {
              // Show what is waiting on the user before the review opens, not after it is answered.
              for (const c of calls) panel.post({ type: 'tool', name: c.toolName, summary: toolSummary(c.toolName, c.args) });
              const answers = await ledger.onApproval(calls);
              answers.forEach((a, i) => {
                if (a.status !== 'deny') return;
                const what = calls[i].toolName === 'run_command' ? `Command not run: ${(calls[i].args as { command?: string })?.command ?? ''}` : `${calls[i].toolName} not applied`;
                panel.post({ type: 'toolError', message: `${what}. ${a.reason ?? ''}` });
              });
              return answers;
            },
          },
          () => stopRequested,
          {
            targets: names.map(name => ({ label: name, createSession: async () => (await client.sessions.create({ agent: { name } })).data.id })),
            changedFiles: () => host.touched.map(c => c.path),
            onSession: (id, label) => {
              currentSessionId = id;
              modelStatus.text = `$(hubot) Keel: ${label}`;
              modelStatus.show();
              panel.post({ type: 'model', label });
            },
            onRetry: r => {
              panel.post({ type: 'retry', ...r });
              out.appendLine(`\n⟳ ${r.target}: transient model error, retry ${r.attempt} in ${(r.delayMs / 1000).toFixed(1)} s${r.hinted ? ' (provider asked)' : ''} (${r.reason})`);
            },
            onSwitch: sw => {
              panel.post({ type: 'switch', from: sw.from, to: sw.to, reason: sw.reason });
              out.appendLine(`\n⇄ switching ${sw.from} → ${sw.to}: ${sw.reason}`);
              modelStatus.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
              void vscode.window.showWarningMessage(`Keel: ${sw.from} failed (${sw.reason}). Continuing on ${sw.to}.`);
            },
          },
        );
        if (outcome.status === 'error') void vscode.window.showErrorMessage(`Keel: ${outcome.message}`);
        out.appendLine(`\n=== ${outcome.status}${outcome.status === 'error' ? `: ${outcome.message}` : ''}`);
        const touched = host.touched.map(c => c.path);
        panel.post({ type: 'end', status: outcome.status, message: outcome.status === 'error' ? outcome.message : undefined, changed: touched });
        if (touched.length) out.appendLine(`Changed this run: ${touched.join(', ')}  (Keel: Undo Last Run reverts them)`);
        if (outcome.status === 'cancelled') {
          const msg = touched.length
            ? `Keel stopped. ${touched.length} file(s) were fully updated before Stop; nothing is half-applied.`
            : 'Keel stopped. No files were changed.';
          // Not awaited: an unanswered notification must not block the next task.
          void vscode.window.showInformationMessage(msg, ...(touched.length ? ['Keep', 'Revert run'] : [])).then(pick => {
            if (pick === 'Revert run') void vscode.commands.executeCommand('keel.run.undo');
          });
        }
      } catch (err) {
        out.appendLine(`\n=== failed: ${String((err as Error).message ?? err)}`);
        panel.post({ type: 'end', status: 'error', message: String((err as Error).message ?? err), changed: host.touched.map(c => c.path) });
      } finally {
        currentSessionId = undefined;
        running = false;
      }
  }

  context.subscriptions.push(
    { dispose: () => void mcp?.close() },
    vscode.commands.registerCommand('keel.agent.run', async () => {
      const request = await vscode.window.showInputBox({ prompt: 'What should Keel do?', ignoreFocusOut: true });
      if (!request) return;
      void vscode.commands.executeCommand(`${KeelPanel.viewId}.focus`);
      await runTask(request);
    }),
    vscode.commands.registerCommand('keel.agent.stop', async () => {
      stopRequested = true;
      ledger.cancel();
      reviewer.cancelAll();
      host.killCommands();
      if (currentSessionId) await client.sessions.cancel(currentSessionId);
    }),
    vscode.commands.registerCommand('keel.run.undo', async () => {
      const r = await host.revertRun();
      const msg = `Keel: reverted ${r.reverted.length} file(s)${r.skipped.length ? `; left ${r.skipped.join(', ')} alone (edited since)` : ''}.`;
      out.appendLine(msg);
      panel.post({ type: 'undone', message: msg });
      void vscode.window.showInformationMessage(msg);
    }),
  );
}

export function deactivate(): Promise<void> | undefined {
  return mcp?.close();
}
