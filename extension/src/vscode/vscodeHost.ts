import * as vscode from 'vscode';
import type { DirEntry, EditorHost, SearchHit } from '../core/host';
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
    if (open) return open.getText();
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
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
