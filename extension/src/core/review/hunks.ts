import { diffLines } from 'diff';

/**
 * A hunk is one contiguous change block: some old lines replaced by some new lines.
 * Hunks never overlap, so any subset of them can be applied independently.
 */
export interface Hunk {
  index: number;
  /** 1-based first old line this hunk replaces (or inserts before). */
  oldStart: number;
  oldLines: string[];
  newLines: string[];
}

interface Segment {
  kind: 'same' | 'change';
  oldText: string;
  newText: string;
}

function segments(oldText: string, newText: string): Segment[] {
  const parts = diffLines(oldText, newText);
  const out: Segment[] = [];
  for (const p of parts) {
    if (!p.added && !p.removed) {
      out.push({ kind: 'same', oldText: p.value, newText: p.value });
      continue;
    }
    const last = out[out.length - 1];
    const target = last && last.kind === 'change' ? last : (out.push({ kind: 'change', oldText: '', newText: '' }), out[out.length - 1]);
    if (p.removed) target.oldText += p.value;
    if (p.added) target.newText += p.value;
  }
  return out;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function computeHunks(oldText: string, newText: string): Hunk[] {
  const hunks: Hunk[] = [];
  let line = 1;
  for (const s of segments(oldText, newText)) {
    if (s.kind === 'change') {
      hunks.push({ index: hunks.length, oldStart: line, oldLines: splitLines(s.oldText), newLines: splitLines(s.newText) });
    }
    line += splitLines(s.oldText).length;
  }
  return hunks;
}

/** Apply only the accepted hunks (by index). All accepted == newText; none == oldText. */
export function applyHunks(oldText: string, newText: string, accepted: ReadonlySet<number>): string {
  let i = 0;
  let out = '';
  for (const s of segments(oldText, newText)) {
    if (s.kind === 'same') {
      out += s.oldText;
    } else {
      out += accepted.has(i) ? s.newText : s.oldText;
      i++;
    }
  }
  return out;
}

/** Render hunks as a compact unified-style preview (used in logs and tool results). */
export function renderHunk(h: Hunk): string {
  const head = `@@ hunk ${h.index + 1} at line ${h.oldStart} @@`;
  return [head, ...h.oldLines.map(l => `- ${l}`), ...h.newLines.map(l => `+ ${l}`)].join('\n');
}
