import * as vscode from 'vscode';
import { CommandRunner, type CommandResult } from '../core/command/run';
import { toLf, type DirEntry, type EditorHost, type SearchHit } from '../core/host';
import { ripgrep } from '../node/nodeHost';

/**
 * EditorHost backed by the VS Code API.
 * Reads prefer the open (possibly unsaved) buffer; writes go through one WorkspaceEdit so the
 * change is atomic and lands on the editor's undo stack (Ctrl+Z reverts it).
 */
export class VscodeHost implements EditorHost {
  constructor(readonly root: string, private readonly out: vscode.OutputChannel) {}

  private uri(rel: string): vscode.Uri {
    return vscode.Uri.joinPath(vscode.Uri.file(this.root), rel);
  }

  async readText(rel: string): Promise<string> {
    const uri = this.uri(rel);
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    // LF everywhere inside Keel; VS Code converts back to the document's own EOL when the edit is applied.
    if (open) return toLf(open.getText());
    return toLf(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(this.uri(rel));
      return true;
    } catch {
      return false;
    }
  }

  async listDir(rel: string): Promise<DirEntry[]> {
    const entries = await vscode.workspace.fs.readDirectory(this.uri(rel || '.'));
    return entries
      .filter(([name]) => name !== '.git')
      .map(([name, type]) => ({ name, type: type === vscode.FileType.Directory ? ('dir' as const) : ('file' as const) }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  }

  search(pattern: string, opts?: { glob?: string; maxResults?: number }): Promise<SearchHit[]> {
    return ripgrep(this.root, pattern, { ...opts, rgPath: bundledRipgrep() });
  }

  async writeText(rel: string, text: string): Promise<void> {
    const uri = this.uri(rel);
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code refused the edit to ${rel}`);
    await doc.save();
  }

  async createFile(rel: string, text: string): Promise<void> {
    const uri = this.uri(rel);
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, { ignoreIfExists: false, contents: new TextEncoder().encode(text) });
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code refused to create ${rel}`);
  }

  async deleteFile(rel: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.deleteFile(this.uri(rel), { ignoreIfNotExists: true });
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code refused to delete ${rel}`);
  }

  private runner?: CommandRunner;
  private term?: { terminal: vscode.Terminal; write: vscode.EventEmitter<string> };

  /** Commands run as child processes; their output is mirrored into a read-only "Keel" terminal. */
  async runCommand(command: string, opts?: { timeoutMs?: number }): Promise<CommandResult> {
    this.runner ??= new CommandRunner(this.root);
    if (!this.term) {
      const write = new vscode.EventEmitter<string>();
      const terminal = vscode.window.createTerminal({ name: 'Keel', pty: { onDidWrite: write.event, open: () => {}, close: () => (this.term = undefined) } });
      this.term = { terminal, write };
    }
    const { terminal, write } = this.term;
    terminal.show(true);
    const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');
    write.fire(crlf(`\x1b[1m$ ${command}\x1b[0m\n`));
    const r = await this.runner.run(command, { ...opts, onOutput: chunk => write.fire(crlf(chunk)) });
    write.fire(crlf(`\x1b[2m(${r.timedOut ? 'timed out' : r.killed ? 'stopped' : `exit ${r.exitCode}`}, ${(r.ms / 1000).toFixed(1)} s)\x1b[0m\n\n`));
    return r;
  }

  killCommands(): void {
    this.runner?.killAll();
  }

  log(message: string): void {
    this.out.appendLine(message);
  }
}

/** VS Code ships ripgrep; use it so users need nothing extra installed. */
function bundledRipgrep(): string | undefined {
  const path = require('node:path') as typeof import('node:path');
  const fs = require('node:fs') as typeof import('node:fs');
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  for (const dir of ['node_modules/@vscode/ripgrep/bin', 'node_modules.asar.unpacked/@vscode/ripgrep/bin']) {
    const p = path.join(vscode.env.appRoot, dir, exe);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}
