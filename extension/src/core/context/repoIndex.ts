import { Bm25, tokenize } from './bm25';
import { buildCoChange, type CoChange } from './cochange';
import { extractSymbols, type CodeSymbol } from './symbols';

export interface DocSection {
  path: string;
  title: string;
  start: number;
  end: number;
}

export type Unit = { kind: 'symbol'; sym: CodeSymbol } | { kind: 'doc'; sec: DocSection };

export interface RepoIndexSources {
  /** Tracked text files, relative paths. */
  listFiles(): Promise<string[]>;
  readFile(path: string): Promise<string>;
  /** `git log --name-only --pretty=format:@@%H -n N` output, or '' if not a git repo. */
  gitLog(): Promise<string>;
}

const CODE_EXT = /\.(py|ts|tsx|js|jsx|mjs|cjs)$/;
const DOC_EXT = /\.(rst|md|txt)$/i;
const MAX_FILE_BYTES = 400_000;

/** In-memory index of a repository: symbols, doc sections, lexical index, references, history. */
export class RepoIndex {
  files = new Map<string, string>();
  symbols: CodeSymbol[] = [];
  symbolsByName = new Map<string, CodeSymbol[]>();
  sections: DocSection[] = [];
  units: Unit[] = [];
  bm25!: Bm25;
  /** doc file -> referenced symbol names (Sphinx roles, autodoc directives, `name()` literals) */
  docRefs = new Map<string, Set<string>>();
  coChange: CoChange = { commits: new Map(), shared: new Map(), totalCommits: 0 };
  buildMs = 0;

  static async build(src: RepoIndexSources): Promise<RepoIndex> {
    const t0 = Date.now();
    const idx = new RepoIndex();
    const paths = (await src.listFiles()).filter(p => CODE_EXT.test(p) || DOC_EXT.test(p));
    await Promise.all(
      paths.map(async p => {
        try {
          const t = (await src.readFile(p)).replace(/\r\n/g, '\n');
          if (t.length <= MAX_FILE_BYTES && !t.includes('\u0000')) idx.files.set(p, t);
        } catch {
          /* unreadable: skip */
        }
      }),
    );
    for (const [p, text] of idx.files) {
      if (CODE_EXT.test(p)) {
        const syms = extractSymbols(p, text);
        idx.symbols.push(...syms);
        for (const s of syms) {
          const list = idx.symbolsByName.get(s.name) ?? [];
          list.push(s);
          idx.symbolsByName.set(s.name, list);
        }
      } else {
        idx.sections.push(...splitDoc(p, text));
        idx.docRefs.set(p, extractDocRefs(text));
      }
    }
    idx.units = [...idx.symbols.map(sym => ({ kind: 'symbol' as const, sym })), ...idx.sections.map(sec => ({ kind: 'doc' as const, sec }))];
    idx.bm25 = new Bm25(
      idx.units.map((u, id) => ({ id, terms: u.kind === 'symbol' ? symbolTerms(u.sym) : sectionTerms(idx.files.get(u.sec.path)!, u.sec) })),
    );
    const known = new Set(idx.files.keys());
    idx.coChange = buildCoChange(await src.gitLog().catch(() => ''), p => known.has(p) || DOC_EXT.test(p));
    idx.buildMs = Date.now() - t0;
    return idx;
  }

  lines(path: string): string[] {
    return (this.files.get(path) ?? '').split('\n');
  }

  symbolsIn(path: string): CodeSymbol[] {
    return this.symbolIdsIn(path).map(i => this.symbols[i]);
  }

  /** Unit ids (== indexes into `symbols`) of the symbols defined in a file. */
  symbolIdsIn(path: string): number[] {
    if (!this.byPath) {
      this.byPath = new Map();
      this.symbols.forEach((s, i) => (this.byPath!.get(s.path) ?? this.byPath!.set(s.path, []).get(s.path)!).push(i));
    }
    return this.byPath.get(path) ?? [];
  }
  private byPath?: Map<string, number[]>;

  /** tests/test_x.py <-> .../x.py, and x.test.ts <-> x.ts */
  testsFor(path: string): string[] {
    const base = path.split('/').pop()!.replace(/\.(py|ts|tsx|js)$/, '');
    const ext = path.slice(path.lastIndexOf('.'));
    const out: string[] = [];
    for (const p of this.files.keys()) {
      const name = p.split('/').pop()!;
      if (name === `test_${base}${ext}` || name === `${base}_test${ext}` || name === `${base}.test${ext}` || name === `${base}.spec${ext}`) out.push(p);
    }
    return out;
  }

  isTest(path: string): boolean {
    return /(^|\/)(tests?|__tests__)\//.test(path) || /(^|\/)test_[^/]+$|_test\.\w+$|\.(test|spec)\.\w+$/.test(path);
  }

  isDoc(path: string): boolean {
    return DOC_EXT.test(path);
  }
}

function symbolTerms(s: CodeSymbol): string[] {
  const name = tokenize(s.qualname);
  return [...name, ...name, ...name, ...tokenize(s.signature), ...tokenize(s.doc).slice(0, 60), ...tokenize(s.path)];
}

function sectionTerms(text: string, sec: DocSection): string[] {
  const body = text.split('\n').slice(sec.start, sec.end + 1).join('\n');
  const title = tokenize(sec.title);
  return [...title, ...title, ...tokenize(body).slice(0, 300), ...tokenize(sec.path)];
}

/** Split reStructuredText / Markdown into heading-delimited sections. */
export function splitDoc(path: string, text: string): DocSection[] {
  const lines = text.split('\n');
  const heads: { line: number; title: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s+\S/.test(lines[i])) heads.push({ line: i, title: lines[i].replace(/^#+\s*/, '') });
    else if (i + 1 < lines.length && lines[i].trim() && /^([=\-~^"'`#*+])\1{2,}\s*$/.test(lines[i + 1]) && lines[i + 1].trim().length >= Math.min(3, lines[i].trim().length)) {
      heads.push({ line: i, title: lines[i].trim() });
    }
  }
  if (heads.length === 0) return [{ path, title: path, start: 0, end: lines.length - 1 }];
  const out: DocSection[] = [];
  if (heads[0].line > 0) out.push({ path, title: path, start: 0, end: heads[0].line - 1 });
  heads.forEach((h, i) => out.push({ path, title: h.title, start: h.line, end: (heads[i + 1]?.line ?? lines.length) - 1 }));
  for (const sec of out) while (sec.end > sec.start && !lines[sec.end].trim()) sec.end--;
  return out;
}

/** Code symbols a doc file points at: :func:`cli.shell_command`, .. autofunction:: flask.x, ``name()``. */
export function extractDocRefs(text: string): Set<string> {
  const out = new Set<string>();
  const add = (dotted: string) => {
    const clean = dotted.replace(/^[~.]+/, '').replace(/\(\)$/, '');
    const last = clean.split('.').pop();
    if (last && /^[A-Za-z_]\w+$/.test(last)) out.add(last);
  };
  for (const m of text.matchAll(/:(?:py:)?(?:func|class|meth|attr|data|obj|exc|mod):`(?:[^`<]*<)?([~.\w]+)>?`/g)) add(m[1]);
  for (const m of text.matchAll(/^\.\.\s+auto(?:function|class|method|attribute|data|module)::\s+([\w.]+)/gm)) add(m[1]);
  for (const m of text.matchAll(/``([A-Za-z_][\w.]*)\(\)``/g)) add(m[1]);
  return out;
}
