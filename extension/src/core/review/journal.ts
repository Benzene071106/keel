import type { DirEntry, EditorHost, SearchHit } from '../host';

export interface Checkpoint {
  path: string;
  /** Text before the run first touched the file; null if the run created it. */
  pre: string | null;
  /** Text after the run's last write. */
  post: string;
}

export interface RevertResult {
  reverted: string[];
  /** Files edited by someone else since the run wrote them; left alone. */
  skipped: string[];
}

/**
 * RunJournal wraps an EditorHost and records a pre-image the first time a run writes each file,
 * so a whole run can be undone in one step ("Undo run"), even across files and after saves.
 */
export class JournaledHost implements EditorHost {
  private checkpoints = new Map<string, Checkpoint>();
  private runId = 0;

  constructor(private readonly inner: EditorHost & { deleteFile?(rel: string): Promise<void> }) {}

  get root() {
    return this.inner.root;
  }

  beginRun(): number {
    this.checkpoints = new Map();
    return ++this.runId;
  }

  get touched(): Checkpoint[] {
    return [...this.checkpoints.values()];
  }

  readText(rel: string) {
    return this.inner.readText(rel);
  }
  exists(rel: string) {
    return this.inner.exists(rel);
  }
  listDir(rel: string): Promise<DirEntry[]> {
    return this.inner.listDir(rel);
  }
  search(pattern: string, opts?: { glob?: string; maxResults?: number }): Promise<SearchHit[]> {
    return this.inner.search(pattern, opts);
  }
  log(m: string) {
    this.inner.log(m);
  }

  async writeText(rel: string, text: string) {
    if (!this.checkpoints.has(rel)) this.checkpoints.set(rel, { path: rel, pre: await this.inner.readText(rel), post: text });
    await this.inner.writeText(rel, text);
    this.checkpoints.get(rel)!.post = text;
  }

  async createFile(rel: string, text: string) {
    await this.inner.createFile(rel, text);
    const cp = this.checkpoints.get(rel);
    if (cp) cp.post = text;
    else this.checkpoints.set(rel, { path: rel, pre: null, post: text });
  }

  /** Restore every file this run touched, unless it changed since the run's last write. */
  async revertRun(): Promise<RevertResult> {
    const out: RevertResult = { reverted: [], skipped: [] };
    for (const cp of [...this.checkpoints.values()].reverse()) {
      const exists = await this.inner.exists(cp.path);
      const current = exists ? await this.inner.readText(cp.path) : null;
      if (current !== cp.post) {
        out.skipped.push(cp.path);
        continue;
      }
      if (cp.pre === null) {
        if (!this.inner.deleteFile) {
          out.skipped.push(cp.path);
          continue;
        }
        await this.inner.deleteFile(cp.path);
      } else {
        await this.inner.writeText(cp.path, cp.pre);
      }
      out.reverted.push(cp.path);
      this.checkpoints.delete(cp.path);
    }
    return out;
  }
}
