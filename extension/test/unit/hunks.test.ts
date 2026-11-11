import { describe, expect, it } from 'vitest';
import { applyHunks, computeHunks } from '../../src/core/review/hunks';
import { applyStrEdits, EditApplyError } from '../../src/core/mcp/edits';

const OLD = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n') + '\n';
const NEW = ['a', 'B', 'c', 'd', 'e2', 'e3', 'f', 'g', 'h'].join('\n') + '\n';

describe('hunks', () => {
  it('splits a diff into independent change blocks', () => {
    const hunks = computeHunks(OLD, NEW);
    expect(hunks.map(h => [h.oldStart, h.newStart, h.oldLines, h.newLines])).toEqual([
      [2, 2, ['b'], ['B']],
      [5, 5, ['e'], ['e2', 'e3']],
      [8, 9, [], ['h']],
    ]);
  });

  it('applying all hunks gives the new text, none gives the old', () => {
    const all = new Set(computeHunks(OLD, NEW).map(h => h.index));
    expect(applyHunks(OLD, NEW, all)).toBe(NEW);
    expect(applyHunks(OLD, NEW, new Set())).toBe(OLD);
  });

  it('applies any subset independently', () => {
    expect(applyHunks(OLD, NEW, new Set([1]))).toBe(['a', 'b', 'c', 'd', 'e2', 'e3', 'f', 'g'].join('\n') + '\n');
    expect(applyHunks(OLD, NEW, new Set([0, 2]))).toBe(['a', 'B', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n') + '\n');
  });

  it('every subset of hunks round-trips on random edits', () => {
    for (let seed = 1; seed <= 50; seed++) {
      let x = seed;
      const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      const old = Array.from({ length: 20 }, (_, i) => `line ${i}`);
      const neu = old.flatMap(l => (rnd() < 0.15 ? [] : rnd() < 0.15 ? [l, `${l} added`] : rnd() < 0.1 ? [`${l} changed`] : [l]));
      const o = old.join('\n') + '\n';
      const n = neu.join('\n') + '\n';
      const hunks = computeHunks(o, n);
      expect(applyHunks(o, n, new Set(hunks.map(h => h.index)))).toBe(n);
      expect(applyHunks(o, n, new Set())).toBe(o);
    }
  });
});

describe('applyStrEdits', () => {
  const src = 'def f():\n    return 1\n\ndef g():\n    return 2\n';
  it('applies unique exact matches in order', () => {
    expect(applyStrEdits(src, [{ old_str: 'return 1', new_str: 'return 10' }, { old_str: 'return 2', new_str: 'return 20' }])).toBe(
      'def f():\n    return 10\n\ndef g():\n    return 20\n',
    );
  });
  it('rejects ambiguous matches', () => {
    expect(() => applyStrEdits(src, [{ old_str: '    return', new_str: 'x' }])).toThrow(EditApplyError);
  });
  it('tolerates trailing whitespace differences', () => {
    expect(applyStrEdits(src, [{ old_str: 'def g():   \n    return 2', new_str: 'def g():\n    return 3' }])).toBe(
      'def f():\n    return 1\n\ndef g():\n    return 3\n',
    );
  });
  it('explains a miss', () => {
    expect(() => applyStrEdits(src, [{ old_str: 'def h():', new_str: '' }])).toThrow(/not found/);
  });
});

import { buildUnifiedView } from '../../src/core/review/unified';
describe('unified view', () => {
  it('interleaves removed then added lines per hunk', () => {
    const v = buildUnifiedView(OLD, computeHunks(OLD, NEW));
    expect(v.text.split('\n').slice(0, -1)).toEqual(['a', 'b', 'B', 'c', 'd', 'e', 'e2', 'e3', 'f', 'g', 'h']);
    expect(v.hunks).toEqual([
      { index: 0, removed: [1, 2], added: [2, 3] },
      { index: 1, removed: [5, 6], added: [6, 8] },
      { index: 2, removed: [10, 10], added: [10, 11] },
    ]);
  });
  it('handles a new file', () => {
    const v = buildUnifiedView('', computeHunks('', 'x\ny\n'));
    expect(v.text).toBe('x\ny\n');
    expect(v.hunks).toEqual([{ index: 0, removed: [0, 0], added: [0, 2] }]);
  });
});
