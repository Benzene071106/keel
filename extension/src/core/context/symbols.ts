/**
 * Lightweight symbol extraction. Indentation-aware regexes for Python, and brace-free
 * declaration regexes for TS/JS. Good enough to rank and slice code; not a parser.
 */
export interface CodeSymbol {
  name: string;
  /** Dotted path inside the file, e.g. "FlaskGroup.list_commands". */
  qualname: string;
  kind: 'function' | 'class' | 'method' | 'const';
  path: string;
  /** 0-based inclusive line range, including decorators. */
  start: number;
  end: number;
  signature: string;
  doc: string;
}

const PY_DEF = /^([ \t]*)(async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const TS_DEF = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|const|let)\s+([A-Za-z_$][\w$]*)/;

function indentOf(line: string): number {
  return line.match(/^[ \t]*/)![0].replace(/\t/g, '    ').length;
}

export function extractSymbols(path: string, text: string): CodeSymbol[] {
  if (path.endsWith('.py')) return extractPython(path, text);
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) return extractTs(path, text);
  return [];
}

function extractPython(path: string, text: string): CodeSymbol[] {
  const lines = text.split('\n');
  const out: CodeSymbol[] = [];
  const stack: { indent: number; qualname: string; kind: string }[] = [];
  let inString: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const startedInString = inString !== null;
    for (const q of lines[i].match(/"""|'''/g) ?? []) {
      if (inString === null) inString = q;
      else if (inString === q) inString = null;
    }
    if (startedInString) continue;
    const m = PY_DEF.exec(lines[i]);
    if (!m) continue;
    const indent = indentOf(m[1]);
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    const isClass = m[2] === 'class';
    const kind: CodeSymbol['kind'] = isClass ? 'class' : parent?.kind === 'class' ? 'method' : 'function';
    const qualname = parent ? `${parent.qualname}.${m[3]}` : m[3];
    // Decorators directly above belong to the symbol.
    let start = i;
    while (start > 0 && /^\s*@/.test(lines[start - 1])) start--;
    // Body ends before the next non-blank line indented at or above this def.
    let end = i;
    let sigEnd = i;
    while (sigEnd < lines.length - 1 && !/:\s*(#.*)?$/.test(lines[sigEnd])) sigEnd++;
    for (let j = sigEnd + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue;
      if (indentOf(lines[j]) <= indent) break;
      end = j;
    }
    end = Math.max(end, sigEnd);
    const signature = lines.slice(i, sigEnd + 1).map(l => l.trim()).join(' ');
    out.push({ name: m[3], qualname, kind, path, start, end, signature, doc: pyDocstring(lines, sigEnd + 1, end) });
    stack.push({ indent, qualname, kind });
  }
  return out;
}

function pyDocstring(lines: string[], from: number, to: number): string {
  for (let j = from; j <= to && j < lines.length; j++) {
    const t = lines[j].trim();
    if (t === '') continue;
    const q = t.startsWith('"""') ? '"""' : t.startsWith("'''") ? "'''" : null;
    if (!q) return '';
    const parts: string[] = [t.slice(3)];
    if (t.length > 3 && t.endsWith(q) && t.length >= 6) return t.slice(3, -3).trim();
    for (let k = j + 1; k <= to && k < lines.length && parts.length < 12; k++) {
      const l = lines[k].trim();
      if (l.includes(q)) {
        parts.push(l.slice(0, l.indexOf(q)));
        break;
      }
      parts.push(l);
    }
    return parts.join(' ').trim();
  }
  return '';
}

function extractTs(path: string, text: string): CodeSymbol[] {
  const lines = text.split('\n');
  const out: CodeSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = TS_DEF.exec(lines[i]);
    if (!m || indentOf(lines[i]) > 0) continue;
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() !== '' && indentOf(lines[j]) === 0 && !/^[}\])]/.test(lines[j].trim())) break;
      end = j;
    }
    while (end > i && lines[end].trim() === '') end--;
    const kind: CodeSymbol['kind'] = m[1] === 'class' || m[1] === 'interface' || m[1] === 'type' ? 'class' : m[1] === 'function' ? 'function' : 'const';
    let doc = '';
    if (i > 0 && lines[i - 1].trim().endsWith('*/')) {
      let k = i - 1;
      const parts: string[] = [];
      while (k >= 0 && !lines[k].includes('/**') && parts.length < 12) parts.unshift(lines[k--]);
      doc = parts.join(' ').replace(/[/*]+/g, ' ').replace(/\s+/g, ' ').trim();
    }
    out.push({ name: m[2], qualname: m[2], kind, path, start: i, end, signature: lines[i].trim(), doc });
  }
  return out;
}
