import { tokenize } from './bm25';
import { coupledFiles } from './cochange';
import type { RepoIndex } from './repoIndex';
import type { CodeSymbol } from './symbols';

export type Granularity = 'full' | 'symbols' | 'sections' | 'outline' | 'head' | 'path';

export interface PackItem {
  path: string;
  role: 'code' | 'test' | 'doc' | 'changelog';
  score: number;
  granularity: Granularity;
  /** 1-based inclusive line ranges included */
  ranges: [number, number][];
  tokens: number;
  reasons: string[];
  content: string;
}

export interface ContextPack {
  query: string;
  budget: number;
  used: number;
  items: PackItem[];
  dropped: { path: string; score: number; reason: string }[];
  ms: number;
}

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

interface Candidate {
  path: string;
  score: number;
  reasons: string[];
  symbols: Map<string, CodeSymbol>;
  sections: Set<number>;
}

const CHANGELOG = /(^|\/)(CHANGES|CHANGELOG|HISTORY|NEWS)(\.\w+)?$/i;

/**
 * Rank files for a request and pack them under a token budget, recording why each one is there.
 * Signals: lexical match (BM25 over symbols and doc sections), explicit @mentions, test-name
 * convention, docs that reference the seed files' symbols, and git co-change with the seeds.
 */
export function contextPack(idx: RepoIndex, query: string, opts: { mentions?: string[]; budget?: number } = {}): ContextPack {
  const t0 = Date.now();
  const budget = opts.budget ?? 12000;
  const cands = new Map<string, Candidate>();
  const cand = (path: string) => {
    let c = cands.get(path);
    if (!c) cands.set(path, (c = { path, score: 0, reasons: [], symbols: new Map(), sections: new Set() }));
    return c;
  };

  // 1. Lexical hits, aggregated per file with diminishing returns.
  const hits = idx.bm25.search(tokenize(query), 60);
  const top = hits[0]?.[1] ?? 1;
  const perFile = new Map<string, number[]>();
  for (const [id, score, matched] of hits) {
    const u = idx.units[id];
    const path = u.kind === 'symbol' ? u.sym.path : u.sec.path;
    const c = cand(path);
    const s = score / top;
    (perFile.get(path) ?? perFile.set(path, []).get(path)!).push(s);
    if (u.kind === 'symbol') {
      if (c.symbols.size < 4) {
        c.symbols.set(u.sym.qualname, u.sym);
        c.reasons.push(`matches ${matched.map(m => `"${m}"`).join(', ')} in ${u.sym.qualname}()`);
      }
    } else if (c.sections.size < 3) {
      c.sections.add(idx.sections.indexOf(u.sec));
      c.reasons.push(`section "${u.sec.title}" matches ${matched.map(m => `"${m}"`).join(', ')}`);
    }
  }
  for (const [path, scores] of perFile) {
    scores.sort((a, b) => b - a);
    // Prose sections are long and match many words, so they get a discount relative to code symbols.
    if (CHANGELOG.test(path)) {
      // Changelogs mention everything; one section's worth of evidence, heavily discounted.
      cand(path).score += 0.3 * scores[0];
      continue;
    }
    const w = idx.isDoc(path) ? 0.6 : 1;
    cand(path).score += w * (scores[0] + 0.25 * scores.slice(1, 4).reduce((a, b) => a + b, 0));
  }

  // 1b. The request names a module: "flask config" / "the cli" -> cli.py, config.py.
  for (const path of idx.files.keys()) {
    if (idx.isDoc(path) || idx.isTest(path)) continue;
    const stem = path.split('/').pop()!.replace(/\.\w+$/, '');
    if (stem !== '__init__' && stem.length > 2 && new RegExp(`\\b${stem}\\b`, 'i').test(query)) {
      const c = cand(path);
      c.score += 0.6;
      c.reasons.unshift(`request names this module ("${stem}")`);
    }
  }

  // 2. Explicit mentions: @path or @symbol.
  for (const m of opts.mentions ?? []) {
    const name = m.replace(/^@/, '');
    if (idx.files.has(name)) {
      const c = cand(name);
      c.score += 10;
      c.reasons.unshift('mentioned by you');
    } else {
      for (const s of idx.symbolsByName.get(name.split('.').pop()!) ?? []) {
        const c = cand(s.path);
        c.score += 10;
        c.symbols.set(s.qualname, s);
        c.reasons.unshift(`you mentioned @${name}`);
      }
    }
  }

  // 3. Expand from the top code seeds through structure and history.
  // Each expansion signal counts once per file (strongest seed wins), so hubs like the
  // changelog don't accumulate a bonus from every seed.
  const bonus = new Map<string, Map<string, number>>();
  const bump = (c: Candidate, kind: string, v: number) => {
    const m = bonus.get(c.path) ?? bonus.set(c.path, new Map()).get(c.path)!;
    m.set(kind, Math.max(m.get(kind) ?? 0, v));
  };
  const seeds = [...cands.values()].filter(c => !idx.isTest(c.path) && !idx.isDoc(c.path)).sort((a, b) => b.score - a.score).slice(0, 3);
  for (const seed of seeds) {
    const s = seed.score;
    for (const t of idx.testsFor(seed.path)) {
      const c = cand(t);
      bump(c, 'test', 0.7 * s);
      c.reasons.push(`test file for ${seed.path} (naming convention)`);
    }
    const seedNames = new Set(idx.symbolsIn(seed.path).map(x => x.name));
    for (const [doc, refs] of idx.docRefs) {
      const shared = [...refs].filter(r => seedNames.has(r));
      if (shared.length === 0) continue;
      const c = cand(doc);
      bump(c, 'doc', 0.5 * s * Math.min(1, shared.length / 2));
      c.reasons.push(`documents ${seed.path}: references ${shared.slice(0, 4).join(', ')}`);
      // Pull in the sections that mention those symbols.
      idx.sections.forEach((sec, i) => {
        if (sec.path !== doc || c.sections.size >= 3) return;
        const body = idx.lines(doc).slice(sec.start, sec.end + 1).join('\n');
        if (shared.some(n => body.includes(n))) c.sections.add(i);
      });
    }
    for (const cp of coupledFiles(idx.coChange, seed.path).slice(0, 8)) {
      const c = cand(cp.path);
      bump(c, 'cochange', 0.8 * s * cp.confidence);
      c.reasons.push(`changed together with ${seed.path} in ${cp.shared} of ${cp.of} commits`);
    }
  }

  for (const [path, m] of bonus) cand(path).score += [...m.values()].reduce((a, b) => a + b, 0);

  // 3b. For the leading code files, pick slices from the file's own best symbols, plus the
  // places in the same file that reference them (where a new command/handler gets registered).
  const qt = tokenize(query);
  const codeTop = [...cands.values()].filter(c => !idx.isDoc(c.path)).sort((a, b) => b.score - a.score).slice(0, 6);
  for (const c of codeTop) refineSymbols(idx, c, qt);

  // 4. Pack greedily under the budget, downgrading granularity before dropping.
  const ranked = [...cands.values()].filter(c => c.score > 0.05).sort((a, b) => b.score - a.score);
  const items: PackItem[] = [];
  const dropped: ContextPack['dropped'] = [];
  let used = 0;
  for (const c of ranked) {
    const options = renderOptions(idx, c);
    const fit = options.find(o => used + o.tokens <= budget);
    if (!fit || items.length >= 12) {
      dropped.push({ path: c.path, score: round(c.score), reason: items.length >= 12 ? 'item limit' : 'over budget' });
      continue;
    }
    used += fit.tokens;
    items.push({
      path: c.path,
      role: CHANGELOG.test(c.path) ? 'changelog' : idx.isTest(c.path) ? 'test' : idx.isDoc(c.path) ? 'doc' : 'code',
      score: round(c.score),
      reasons: dedupe(c.reasons).sort((a, b) => reasonRank(a) - reasonRank(b)).slice(0, 4),
      ...fit,
    });
  }
  return { query, budget, used, items, dropped: dropped.slice(0, 10), ms: Date.now() - t0 };
}

function refineSymbols(idx: RepoIndex, c: Candidate, qt: string[]) {
  const ids = idx.symbolIdsIn(c.path);
  if (ids.length === 0) return;
  const mentioned = [...c.symbols.values()].filter(s => c.reasons.some(r => r.startsWith('you mentioned')));
  const best = idx.bm25
    .search(qt, 8, ids)
    .map(([id, , matched]) => ({ sym: idx.symbols[id], matched }))
    // A class whose methods also match is redundant with them.
    .filter((h, _, all) => !(h.sym.kind === 'class' && all.some(o => o.sym.qualname.startsWith(h.sym.qualname + '.'))))
    .slice(0, 3);
  c.symbols = new Map(mentioned.map(s => [s.qualname, s]));
  c.reasons = c.reasons.filter(r => !r.startsWith('matches '));
  for (const { sym, matched } of best) {
    if (c.symbols.size >= 4) break;
    c.symbols.set(sym.qualname, sym);
    c.reasons.push(`matches ${matched.map(m => `"${m}"`).join(', ')} in ${sym.qualname}()`);
  }
  // Innermost symbols elsewhere in the file that reference a chosen top-level symbol by name.
  const lines = idx.lines(c.path);
  const chosen = [...c.symbols.values()].filter(s => !s.qualname.includes('.'));
  let added = 0;
  for (const target of chosen) {
    const re = new RegExp(`\\b${target.name}\\b`);
    const users = ids
      .map(i => idx.symbols[i])
      .filter(u => u !== target && !c.symbols.has(u.qualname) && (u.end < target.start || u.start > target.end))
      .filter(u => lines.slice(u.start + 1, u.end + 1).some(l => re.test(l)));
    const innermost = users.filter(u => !users.some(o => o !== u && o.start >= u.start && o.end <= u.end));
    for (const u of innermost.slice(0, 1)) {
      if (added >= 2) break;
      c.symbols.set(u.qualname, u);
      c.reasons.push(`${u.qualname}() references ${target.name}`);
      added++;
    }
  }
}

function renderOptions(idx: RepoIndex, c: Candidate): Omit<PackItem, 'path' | 'role' | 'score' | 'reasons'>[] {
  const lines = idx.lines(c.path);
  const opts: Omit<PackItem, 'path' | 'role' | 'score' | 'reasons'>[] = [];
  const mk = (granularity: Granularity, ranges: [number, number][]) => {
    const content = ranges.map(([a, b]) => `${a > 1 ? `... (line ${a})\n` : ''}${lines.slice(a - 1, b).join('\n')}`).join('\n');
    opts.push({ granularity, ranges, content, tokens: estimateTokens(content) + 30 });
  };
  const total = estimateTokens(lines.join('\n'));
  if (CHANGELOG.test(c.path)) {
    mk('head', [[1, Math.min(lines.length, 30)]]);
  } else if (idx.isDoc(c.path)) {
    if (c.sections.size) mk('sections', mergeRanges([...c.sections].map(i => [idx.sections[i].start + 1, Math.min(idx.sections[i].end + 1, idx.sections[i].start + 60)])));
    mk('outline', mergeRanges(idx.sections.filter(s => s.path === c.path).map(s => [s.start + 1, s.start + 1])));
  } else {
    if (total <= 1500) mk('full', [[1, lines.length]]);
    if (c.symbols.size) mk('symbols', mergeRanges([...c.symbols.values()].map(s => [s.start + 1, Math.min(s.end + 1, s.start + 120)])));
    const outline = idx.symbolsIn(c.path).filter(s => s.kind !== 'method' || c.symbols.size === 0).slice(0, 60);
    if (outline.length) mk('outline', mergeRanges(outline.map(s => [s.start + 1, s.start + 1])));
  }
  opts.push({ granularity: 'path', ranges: [], content: '', tokens: 15 });
  return opts;
}

function mergeRanges(r: [number, number][]): [number, number][] {
  const s = [...r].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 2) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Strongest evidence first: what the user said, then structure and history, then word overlap. */
const REASON_ORDER = [/^mentioned by you|^you mentioned/, /^request names/, /^test file/, /^changed together/, /^documents /, /references /, /^matches /, /^section /];
const reasonRank = (r: string) => {
  const i = REASON_ORDER.findIndex(re => re.test(r));
  return i < 0 ? REASON_ORDER.length : i;
};

const round = (n: number) => Math.round(n * 100) / 100;
const dedupe = (a: string[]) => [...new Set(a)];

/** What the model sees: a header per file with the reasons, then the selected code. */
export function renderPack(p: ContextPack): string {
  const head = `Context pack for: "${p.query}"\nBudget ${p.used}/${p.budget} tokens, ${p.items.length} files. Files are ranked; reasons explain why each was chosen.\n`;
  const body = p.items
    .map((it, i) => {
      const where = it.granularity === 'path' ? '(path only; call read_file if needed)' : `(${it.granularity}, lines ${it.ranges.map(([a, b]) => `${a}-${b}`).join(', ')})`;
      return `\n### ${i + 1}. ${it.path} [${it.role}] ${where}\nWhy: ${it.reasons.join('; ')}\n${it.content ? '```\n' + it.content + '\n```' : ''}`;
    })
    .join('\n');
  const tail = p.dropped.length ? `\n\nAlso relevant but left out for budget: ${p.dropped.map(d => d.path).join(', ')}` : '';
  return head + body + tail;
}
