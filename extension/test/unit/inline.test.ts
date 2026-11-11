import { describe, expect, it } from 'vitest';
import { buildInlinePrompt, parseInlineOutput, reindent, spliceLines } from '../../src/core/inline/inline';

const FILE = 'import os\n\nclass A:\n    def f(self):\n        return 1\n\n    def g(self):\n        return 2\n';

describe('inline edit', () => {
  it('prompt contains the selection, context, and instruction', () => {
    const p = buildInlinePrompt({ path: 'a.py', languageId: 'python', fileText: FILE, startLine: 3, endLine: 4, instruction: 'return 10' });
    expect(p).toContain('SELECTED CODE');
    expect(p).toContain('    def f(self):\n        return 1');
    expect(p).toContain('import os');
    expect(p).toContain('Instruction: return 10');
  });

  it('parses fenced, chatty, unfenced and truncated replies', () => {
    const orig = '    def f(self):\n        return 1';
    expect(parseInlineOutput('Sure!\n```python\n    def f(self):\n        return 10\n```\nDone.', orig)).toBe('    def f(self):\n        return 10');
    expect(parseInlineOutput('    def f(self):\n        return 10\n', orig)).toBe('    def f(self):\n        return 10');
    expect(parseInlineOutput('```python\n    def f(self):\n        return 10\n', orig)).toBe('    def f(self):\n        return 10');
  });

  it('restores dropped base indentation', () => {
    expect(reindent('def f(self):\n    return 10', '    def f(self):\n        return 1')).toBe('    def f(self):\n        return 10');
    expect(reindent('    x = 1', '    y = 2')).toBe('    x = 1');
  });

  it('rejects empty replies', () => {
    expect(() => parseInlineOutput('```python\n\n```', 'x')).toThrow();
  });

  it('splices whole lines', () => {
    expect(spliceLines(FILE, 3, 4, '    def f(self):\n        return 10')).toBe(FILE.replace('return 1\n', 'return 10\n'));
  });
});
