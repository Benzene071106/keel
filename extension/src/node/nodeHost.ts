import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { DirEntry, EditorHost, SearchHit } from '../core/host';

/** Plain-filesystem EditorHost for headless runs and tests. */
export class NodeHost implements EditorHost {
  constructor(readonly root: string, private readonly logger: (m: string) => void = () => {}) {}

  private abs(rel: string) {
    return path.join(this.root, rel);
  }
  async readText(rel: string) {
    return fs.readFile(this.abs(rel), 'utf8');
  }
  async exists(rel: string) {
    return fs.access(this.abs(rel)).then(() => true, () => false);
  }
  async listDir(rel: string): Promise<DirEntry[]> {
    const entries = await fs.readdir(this.abs(rel), { withFileTypes: true });
    return entries
      .filter(e => e.name !== '.git')
      .map(e => ({ name: e.name, type: e.isDirectory() ? ('dir' as const) : ('file' as const) }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  }
  search(pattern: string, opts: { glob?: string; maxResults?: number } = {}): Promise<SearchHit[]> {
    return ripgrep(this.root, pattern, opts);
  }
  async writeText(rel: string, text: string) {
    // Write-then-rename so a crash can never leave a half-written file.
    const tmp = `${this.abs(rel)}.keel-tmp-${process.pid}`;
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, this.abs(rel));
  }
  async createFile(rel: string, text: string) {
    await fs.mkdir(path.dirname(this.abs(rel)), { recursive: true });
    await fs.writeFile(this.abs(rel), text, { encoding: 'utf8', flag: 'wx' });
  }
  log(m: string) {
    this.logger(m);
  }
}

export function ripgrep(root: string, pattern: string, opts: { glob?: string; maxResults?: number; rgPath?: string } = {}): Promise<SearchHit[]> {
  const max = opts.maxResults ?? 50;
  const args = ['--json', '--max-count', '20', '--max-columns', '300', '-e', pattern];
  if (opts.glob) args.push('--glob', opts.glob);
  args.push('.');
  return new Promise((resolve, reject) => {
    execFile(opts.rgPath ?? 'rg', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      // rg exits 1 when there are no matches.
      if (err && (err as { code?: unknown }).code !== 1 && !stdout) return reject(err);
      const hits: SearchHit[] = [];
      for (const line of stdout.split('\n')) {
        if (!line || hits.length >= max) continue;
        const ev = JSON.parse(line);
        if (ev.type !== 'match') continue;
        hits.push({
          path: String(ev.data.path.text).replace(/^\.\//, ''),
          line: ev.data.line_number,
          text: ev.data.lines.text ?? '',
        });
      }
      resolve(hits);
    });
  });
}
