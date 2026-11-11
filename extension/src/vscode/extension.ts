import * as vscode from 'vscode';
import { startMcpServer, type RunningMcpServer } from '../core/mcp/server';
import { DecisionLedger } from '../core/review/ledger';
import { JournaledHost } from '../core/review/journal';
import { EditorReviewer } from './review';
import { createClient, registerMcpServer } from '../core/trueforge/client';
import { runRequest } from '../core/trueforge/turnRunner';
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
    mcp = await startMcpServer({
      host,
      gate: ledger,
      events: {
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

  registerInlineEdit(context, { client, host, reviewer, out, agentName: () => cfg<string>('inlineAgent') });

  context.subscriptions.push(
    { dispose: () => void mcp?.close() },
    vscode.commands.registerCommand('keel.agent.run', async () => {
      await ready;
      const request = await vscode.window.showInputBox({ prompt: 'What should Keel do?', ignoreFocusOut: true });
      if (!request) return;
      out.show(true);
      out.appendLine(`\n=== ${request}`);
      stopRequested = false;
      host.beginRun();
      ledger.begin();
      try {
        const { data: session } = await client.sessions.create({ agent: { name: cfg<string>('agent') } });
        currentSessionId = session.id;
        const outcome = await runRequest(
          client,
          session.id,
          request,
          {
            onText: (t, thread) => {
              if (!thread || thread === 'main') out.append(t);
            },
            onApproval: calls => ledger.onApproval(calls),
          },
          () => stopRequested,
        );
        out.appendLine(`\n=== ${outcome.status}${outcome.status === 'error' ? `: ${outcome.message}` : ''}`);
        const touched = host.touched.map(c => c.path);
        if (touched.length) out.appendLine(`Changed this run: ${touched.join(', ')}  (Keel: Undo Last Run reverts them)`);
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
