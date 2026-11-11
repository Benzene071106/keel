import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CommandRunner } from '../core/command/run';
import { toLf, usesCrlf, withEol, type DirEntry, type EditorHost, type SearchHit } from '../core/host';

/** Plain-filesystem EditorHost for headless runs and tests. */
export class NodeHost implements EditorHost {
  constructor(readonly root: string, private readonly logger: (m: string) => void = () => {}) {}

  private abs(rel: string) {
    return path.join(this.root, rel);
  }
  async readText(rel: string) {
    return toLf(await fs.readFile(this.abs(rel), 'utf8'));
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
    // Keep the file's own line endings (CRLF checkouts on Windows).
    const crlf = usesCrlf(await fs.readFile(this.abs(rel), 'utf8').catch(() => ''));
    await fs.writeFile(tmp, withEol(text, crlf), 'utf8');
    await fs.rename(tmp, this.abs(rel));
  }
  async createFile(rel: string, text: string) {
    await fs.mkdir(path.dirname(this.abs(rel)), { recursive: true });
    await fs.writeFile(this.abs(rel), text, { encoding: 'utf8', flag: 'wx' });
  }
  async deleteFile(rel: string) {
    await fs.unlink(this.abs(rel));
  }
  private runner?: CommandRunner;
  runCommand(command: string, opts?: { timeoutMs?: number }) {
    this.runner ??= new CommandRunner(this.root);
    return this.runner.run(command, opts);
  }
  killCommands() {
    this.runner?.killAll();
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
      // No ripgrep on this machine (common on Windows): search in-process instead of failing.
      if (err && (err as { code?: unknown }).code === 'ENOENT') return jsSearch(root, pattern, opts).then(resolve, reject);
      // rg exits 1 when there are no matches.
      if (err && (err as { code?: unknown }).code !== 1 && !stdout) return reject(err);
      const hits: SearchHit[] = [];
      for (const line of stdout.split('\n')) {
        if (!line || hits.length >= max) continue;
        const ev = JSON.parse(line);
        if (ev.type !== 'match') continue;
        hits.push({
          // rg prints .\src\x.py on Windows; tools use forward slashes everywhere.
          path: String(ev.data.path.text).replace(/\\/g, '/').replace(/^\.\//, ''),
          line: ev.data.line_number,
          text: ev.data.lines.text ?? '',
        });
      }
      resolve(hits);
    });
  });
}

/** "*.py", "docs/**", "src/**\/*.ts" -> RegExp over forward-slash relative paths. A glob without "/" matches at any depth, like rg. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!g.includes('/')) g = `**/${g}`;
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.tox', '.mypy_cache', '.pytest_cache']);

async function listFiles(root: string): Promise<string[]> {
  const tracked = await new Promise<string[] | null>(res =>
    execFile('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (err, out) => res(err ? null : out.split('\0').filter(Boolean))),
  );
  if (tracked) return tracked;
  const out: string[] = [];
  const walk = async (rel: string) => {
    for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(p);
      } else if (e.isFile()) out.push(p);
    }
  };
  await walk('');
  return out;
}

/** ripgrep stand-in: same result shape, JavaScript regex, tracked + untracked-not-ignored files. */
export async function jsSearch(root: string, pattern: string, opts: { glob?: string; maxResults?: number } = {}): Promise<SearchHit[]> {
  const max = opts.maxResults ?? 50;
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    throw new Error(`Invalid regular expression: ${(e as Error).message}`);
  }
  const glob = opts.glob ? globToRegExp(opts.glob) : null;
  const hits: SearchHit[] = [];
  for (const rel of (await listFiles(root)).sort()) {
    if (hits.length >= max) break;
    if (glob && !glob.test(rel)) continue;
    let text: string;
    try {
      const stat = await fs.stat(path.join(root, rel));
      if (stat.size > 1_000_000) continue;
      text = await fs.readFile(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue;
    const lines = text.split(/\r?\n/);
    let perFile = 0;
    for (let i = 0; i < lines.length && hits.length < max && perFile < 20; i++) {
      if (re.test(lines[i])) {
        hits.push({ path: rel, line: i + 1, text: lines[i].slice(0, 300) });
        perFile++;
      }
    }
  }
  return hits;
}
