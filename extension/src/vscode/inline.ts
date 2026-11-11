import * as vscode from 'vscode';
import type { TrueForge } from '@truefoundry/trueforge-sdk';
import { runInline, type InlineResult } from '../core/inline/runInline';
import type { InlineRequest } from '../core/inline/inline';
import { applyHunks, computeHunks } from '../core/review/hunks';
import { toLf, type EditorHost } from '../core/host';
import type { EditorReviewer } from './review';

const STREAM_SCHEME = 'keel-stream';

/** Live, read-only preview of the tokens as they stream in. */
class StreamPreview implements vscode.TextDocumentContentProvider {
  private text = '';
  private timer: NodeJS.Timeout | undefined;
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  readonly uri = vscode.Uri.from({ scheme: STREAM_SCHEME, path: '/Keel (streaming).md' });

  provideTextDocumentContent(): string {
    return this.text;
  }
  reset(header: string) {
    this.text = header;
    this.emitter.fire(this.uri);
  }
  append(chunk: string) {
    this.text += chunk;
    // Coalesce redraws so a fast stream never floods the editor.
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.emitter.fire(this.uri);
    }, 40);
  }
}

export interface InlineDeps {
  client: TrueForge;
  host: EditorHost;
  reviewer: EditorReviewer;
  out: vscode.OutputChannel;
  /** Run the inline request with failover (wired in by the extension). */
  run?: (req: InlineRequest, hooks: Parameters<typeof runInline>[3]) => Promise<InlineResult & { agent?: string }>;
  agentName: () => string;
}

export function registerInlineEdit(context: vscode.ExtensionContext, deps: InlineDeps): void {
  const preview = new StreamPreview();
  let running: { stop: () => Promise<void> } | undefined;

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(STREAM_SCHEME, preview),
    vscode.commands.registerCommand('keel.inline.cancel', async () => {
      await running?.stop();
    }),
    vscode.commands.registerCommand('keel.inline.edit', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') {
        void vscode.window.showInformationMessage('Keel: select code in a file first.');
        return;
      }
      if (running) {
        void vscode.window.showInformationMessage('Keel: an inline edit is already running (Esc cancels it).');
        return;
      }
      const doc = editor.document;
      const sel = editor.selection;
      const startLine = sel.start.line;
      const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
      const instruction = await vscode.window.showInputBox({
        prompt: `Keel: edit lines ${startLine + 1}-${endLine + 1}`,
        placeHolder: 'Describe the change',
        ignoreFocusOut: true,
      });
      if (!instruction) return;

      const rel = vscode.workspace.asRelativePath(doc.uri, false);
      const fileText = toLf(doc.getText());
      const version = doc.version;
      const req: InlineRequest = { path: rel, languageId: doc.languageId, fileText, startLine, endLine, instruction };

      let stopped = false;
      let sessionId: string | undefined;
      running = {
        stop: async () => {
          stopped = true;
          if (sessionId) await deps.client.sessions.cancel(sessionId).catch(() => undefined);
        },
      };
      await vscode.commands.executeCommand('setContext', 'keel.inlineRunning', true);
      preview.reset(`<!-- Keel is rewriting ${rel}:${startLine + 1}-${endLine + 1} — press Esc to cancel -->\n\n`);
      const previewDoc = await vscode.workspace.openTextDocument(preview.uri);
      await vscode.window.showTextDocument(previewDoc, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: true });

      const hooks = {
        onSession: (id: string) => (sessionId = id),
        onText: (t: string) => preview.append(t),
        shouldStop: () => stopped,
      };
      let res: InlineResult & { agent?: string };
      try {
        res = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: 'Keel: generating edit (Esc to cancel)' },
          () => (deps.run ? deps.run(req, hooks) : runInline(deps.client, deps.agentName(), req, hooks)),
        );
      } finally {
        running = undefined;
        await vscode.commands.executeCommand('setContext', 'keel.inlineRunning', false);
        await closeTabs(preview.uri);
      }

      if (res.status === 'cancelled') {
        deps.out.appendLine(`Inline edit cancelled; ${rel} untouched.`);
        void vscode.window.showInformationMessage('Keel: inline edit cancelled. No changes were made.');
        return;
      }
      if (res.status === 'error') {
        deps.out.appendLine(`Inline edit failed: ${res.message}`);
        void vscode.window.showErrorMessage(`Keel: inline edit failed — ${res.message}. No changes were made.`);
        return;
      }
      if (doc.version !== version) {
        void vscode.window.showWarningMessage('Keel: the file changed while the edit was generating; discarded the proposal. No changes were made.');
        return;
      }
      const hunks = computeHunks(fileText, res.newFileText);
      if (hunks.length === 0) {
        void vscode.window.showInformationMessage('Keel: the model proposed no change.');
        return;
      }
      const [decision] = await deps.reviewer.review([
        { key: `inline-${Date.now()}`, tool: 'propose_edit', path: rel, oldText: fileText, newText: res.newFileText, hunks },
      ]);
      if (!decision || decision.accepted.length === 0) {
        void vscode.window.showInformationMessage('Keel: all hunks rejected. No changes were made.');
        return;
      }
      if (toLf(doc.getText()) !== fileText) {
        void vscode.window.showWarningMessage('Keel: the file changed during review; not applying. No changes were made.');
        return;
      }
      await deps.host.writeText(rel, applyHunks(fileText, res.newFileText, new Set(decision.accepted)));
      await vscode.window.showTextDocument(doc, editor.viewColumn);
      deps.out.appendLine(`Inline edit applied ${decision.accepted.length}/${hunks.length} hunk(s) to ${rel}${res.agent ? ` via ${res.agent}` : ''}. Ctrl/Cmd+Z undoes it.`);
    }),
  );
}

async function closeTabs(uri: vscode.Uri) {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const u = (tab.input as { uri?: vscode.Uri } | undefined)?.uri;
      if (u && u.toString() === uri.toString()) await vscode.window.tabGroups.close(tab);
    }
  }
}
