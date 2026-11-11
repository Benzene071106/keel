import type { Hunk } from './hunks';

export interface UnifiedHunkRange {
  index: number;
  /** 0-based [start, end) line ranges inside the unified text. */
  removed: [number, number];
  added: [number, number];
}

export interface UnifiedView {
  text: string;
  hunks: UnifiedHunkRange[];
}

/**
 * Interleave old and new lines so every hunk shows its removed lines followed by its added lines,
 * with unchanged context around them. This is what the review editor renders, decorated red/green.
 */
export function buildUnifiedView(oldText: string, hunks: Hunk[]): UnifiedView {
  const oldLines = oldText === '' ? [] : oldText.replace(/\n$/, '').split('\n');
  const out: string[] = [];
  const ranges: UnifiedHunkRange[] = [];
  let oldIdx = 0; // 0-based index of the next old line to emit
  for (const h of hunks) {
    const start = h.oldStart - 1;
    while (oldIdx < start) out.push(oldLines[oldIdx++]);
    const rStart = out.length;
    for (const l of h.oldLines) out.push(l);
    const aStart = out.length;
    for (const l of h.newLines) out.push(l);
    ranges.push({ index: h.index, removed: [rStart, aStart], added: [aStart, out.length] });
    oldIdx += h.oldLines.length;
  }
  while (oldIdx < oldLines.length) out.push(oldLines[oldIdx++]);
  return { text: out.join('\n') + '\n', hunks: ranges };
}
