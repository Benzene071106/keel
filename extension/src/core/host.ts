/**
 * EditorHost is everything the agent's tools may do to the workspace.
 * The VS Code adapter implements it with the editor API (dirty buffers, WorkspaceEdit, undo);
 * the Node adapter implements it with plain fs so the whole loop can run headless in tests.
 */
export interface DirEntry {
  name: string;
  type: 'file' | 'dir';
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface EditorHost {
  /** Absolute workspace root. All tool paths are relative to it. */
  readonly root: string;
  readText(relPath: string): Promise<string>;
  exists(relPath: string): Promise<boolean>;
  listDir(relPath: string): Promise<DirEntry[]>;
  search(pattern: string, opts?: { glob?: string; maxResults?: number }): Promise<SearchHit[]>;
  /** Replace a file's full text atomically (one undo step in the editor). */
  writeText(relPath: string, text: string): Promise<void>;
  /** Create a new file; fails if it exists. */
  createFile(relPath: string, text: string): Promise<void>;
  /** Delete a file (used only to undo a file the agent created). */
  deleteFile?(relPath: string): Promise<void>;
  log(message: string): void;
}

/** Resolve a tool-supplied path and refuse anything that escapes the workspace. */
export function safeRelPath(root: string, relPath: string): string {
  const path = require('node:path') as typeof import('node:path');
  const cleaned = relPath.replace(/^[/\\]+/, '');
  const abs = path.resolve(root, cleaned);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes the workspace: ${relPath}`);
  }
  if (rel.split(path.sep)[0] === '.git') {
    throw new Error(`Refusing to touch .git: ${relPath}`);
  }
  return rel.split(path.sep).join('/');
}
