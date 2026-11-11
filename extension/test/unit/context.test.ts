import { describe, expect, it } from 'vitest';
import { tokenize, Bm25 } from '../../src/core/context/bm25';
import { buildCoChange, coupledFiles } from '../../src/core/context/cochange';
import { extractSymbols } from '../../src/core/context/symbols';
import { RepoIndex, extractDocRefs, splitDoc } from '../../src/core/context/repoIndex';
import { contextPack, renderPack } from '../../src/core/context/pack';

describe('tokenize', () => {
  it('splits snake and camel case and stems', () => {
    expect(tokenize('get_debug_flag')).toEqual(['get', 'debug', 'flag']);
    expect(tokenize('listCommands masking')).toEqual(['list', 'command', 'mask']);
  });
});

describe('bm25', () => {
  it('ranks the matching doc first and can be restricted to ids', () => {
    const b = new Bm25([
      { id: 0, terms: ['shell', 'command'] },
      { id: 1, terms: ['config', 'load', 'json'] },
      { id: 2, terms: ['route', 'command'] },
    ]);
    expect(b.search(['config'])[0][0]).toBe(1);
    expect(b.search(['command'], 10, [2]).map(h => h[0])).toEqual([2]);
  });
});

describe('symbols', () => {
  it('extracts python classes, methods, decorators and docstrings', () => {
    const src = ['import x', '', '@click.command("shell")', 'def shell_command():', '    """Run a shell."""', '    pass', '', 'class FlaskGroup:', '    def __init__(self):', '        self.add_command(shell_command)', ''].join('\n');
    const s = extractSymbols('cli.py', src);
    const shell = s.find(x => x.name === 'shell_command')!;
    expect(shell.start).toBe(2);
    expect(shell.end).toBe(5);
    expect(shell.doc).toBe('Run a shell.');
    expect(s.find(x => x.name === '__init__')!.qualname).toBe('FlaskGroup.__init__');
    expect(s.find(x => x.name === '__init__')!.kind).toBe('method');
  });
  it('extracts top-level TS declarations', () => {
    const s = extractSymbols('a.ts', 'export function foo() {\n  return 1;\n}\nexport const bar = 2;\n');
    expect(s.map(x => [x.name, x.start, x.end])).toEqual([['foo', 0, 2], ['bar', 3, 3]]);
  });
});

describe('cochange', () => {
  const log = ['@@a', 'cli.py', 'CHANGES.rst', '', '@@b', 'cli.py', 'CHANGES.rst', 'tests/test_cli.py', '', '@@c', 'cli.py', 'CHANGES.rst', '', '@@d', 'cli.py', 'app.py'].join('\n');
  it('computes confidence and filters by support', () => {
    const cc = buildCoChange(log);
    expect(cc.totalCommits).toBe(4);
    const c = coupledFiles(cc, 'cli.py');
    expect(c).toEqual([{ path: 'CHANGES.rst', shared: 3, of: 4, confidence: 0.75 }]);
  });
  it('skips huge commits', () => {
    const big = '@@x\n' + Array.from({ length: 31 }, (_, i) => `f${i}.py`).join('\n');
    expect(buildCoChange(big).totalCommits).toBe(0);
  });
});

describe('docs', () => {
  it('splits rst and md headings', () => {
    const secs = splitDoc('d.rst', 'Title\n=====\n\nintro\n\nUsage\n-----\nbody\n');
    expect(secs.map(s => [s.title, s.start, s.end])).toEqual([['Title', 0, 3], ['Usage', 5, 7]]);
    expect(splitDoc('r.md', '# A\nx\n## B\ny').map(s => s.title)).toEqual(['A', 'B']);
  });
  it('finds sphinx references', () => {
    const r = extractDocRefs(':func:`~flask.cli.shell_command` and ``load_dotenv()``\n\n.. autoclass:: flask.cli.FlaskGroup');
    expect([...r].sort()).toEqual(['FlaskGroup', 'load_dotenv', 'shell_command']);
  });
});

describe('contextPack', () => {
  const files: Record<string, string> = {
    'src/pkg/cli.py': ['@click.command("shell")', 'def shell_command():', '    """Run an interactive shell."""', '    pass', '', 'class AppGroup:', '    def __init__(self):', '        self.add_command(shell_command)', ''].join('\n'),
    'src/pkg/helpers.py': 'def get_debug_flag():\n    """Debug flag from env."""\n    return 1\n',
    'tests/test_cli.py': 'def test_shell():\n    pass\n',
    'docs/cli.rst': 'Command Line\n============\n\nUse :func:`shell_command` to open a shell.\n',
    'CHANGES.rst': 'Version 1\n---------\n\n- things\n',
  };
  const log = Array.from({ length: 4 }, (_, i) => `@@c${i}\nsrc/pkg/cli.py\nCHANGES.rst`).join('\n');
  const build = () => RepoIndex.build({ listFiles: async () => Object.keys(files), readFile: async p => files[p], gitLog: async () => log });

  it('finds code, test, doc and changelog with reasons', async () => {
    const idx = await build();
    const p = contextPack(idx, 'add a new cli command like the shell command');
    const by = Object.fromEntries(p.items.map(i => [i.path, i]));
    expect(p.items[0].path).toBe('src/pkg/cli.py');
    expect(by['tests/test_cli.py'].reasons.join()).toMatch(/test file for src\/pkg\/cli.py/);
    expect(by['docs/cli.rst'].reasons.join()).toMatch(/references shell_command/);
    expect(by['CHANGES.rst'].reasons[0]).toMatch(/changed together with src\/pkg\/cli.py in 4 of 4/);
    // Registration site comes along with the matched command.
    expect(by['src/pkg/cli.py'].content).toContain('add_command(shell_command)');
    expect(p.used).toBeLessThanOrEqual(p.budget);
    expect(renderPack(p)).toContain('Why:');
  });

  it('honours mentions and degrades granularity under a tight budget', async () => {
    const idx = await build();
    const p = contextPack(idx, 'shell', { mentions: ['@get_debug_flag'], budget: 120 });
    expect(p.items[0].path).toBe('src/pkg/helpers.py');
    expect(p.items[0].reasons[0]).toBe('you mentioned @get_debug_flag');
    expect(p.used).toBeLessThanOrEqual(120);
    expect(p.items.some(i => i.granularity === 'path') || p.dropped.length > 0).toBe(true);
  });
});

describe('symbols in docstrings', () => {
  it('ignores def/class words inside triple-quoted strings', () => {
    const src = ['def f():', '    """Load.', '', '    class and has attributes', '    def not_real', '    """', '    pass', 'def g():', '    pass'].join('\n');
    expect(extractSymbols('c.py', src).map(s => s.qualname)).toEqual(['f', 'g']);
  });
});
