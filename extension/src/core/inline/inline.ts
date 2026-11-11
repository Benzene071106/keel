/**
 * Inline edit: the user selects lines and types an instruction; the model returns replacement code
 * for exactly those lines. Everything here is pure so it can be unit-tested without VS Code.
 */

export interface InlineRequest {
  path: string;
  languageId: string;
  fileText: string;
  /** 0-based, inclusive line range of the selection (always whole lines). */
  startLine: number;
  endLine: number;
  instruction: string;
}

const CONTEXT_BEFORE = 60;
const CONTEXT_AFTER = 30;

export function selectionText(req: Pick<InlineRequest, 'fileText' | 'startLine' | 'endLine'>): string {
  return req.fileText.split('\n').slice(req.startLine, req.endLine + 1).join('\n');
}

export function buildInlinePrompt(req: InlineRequest): string {
  const lines = req.fileText.split('\n');
  const before = lines.slice(Math.max(0, req.startLine - CONTEXT_BEFORE), req.startLine).join('\n');
  const after = lines.slice(req.endLine + 1, req.endLine + 1 + CONTEXT_AFTER).join('\n');
  const header = lines.slice(0, Math.min(25, req.startLine)).filter(l => /^(import|from|#include|using|package|require)\b/.test(l.trim())).join('\n');
  const fence = '```';
  return [
    `File: ${req.path} (${req.languageId}), selected lines ${req.startLine + 1}-${req.endLine + 1}.`,
    header && `Imports at the top of the file:\n${fence}${req.languageId}\n${header}\n${fence}`,
    `Code before the selection:\n${fence}${req.languageId}\n${before}\n${fence}`,
    `SELECTED CODE (rewrite only this):\n${fence}${req.languageId}\n${selectionText(req)}\n${fence}`,
    `Code after the selection:\n${fence}${req.languageId}\n${after}\n${fence}`,
    `Instruction: ${req.instruction}`,
    'Reply with ONLY the full replacement for the selected code, inside one fenced code block, keeping its original indentation. ' +
      'Do not include the code before or after the selection. No explanation.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export class InlineParseError extends Error {}

/** Extract the replacement code from a model reply, tolerating chatty or unfenced answers. */
export function parseInlineOutput(reply: string, original: string): string {
  const fences = [...reply.matchAll(/```[^\n`]*\n([\s\S]*?)```/g)].map(m => m[1]);
  let code: string;
  if (fences.length > 0) {
    // Prefer the longest block: models sometimes add a tiny usage example.
    code = fences.reduce((a, b) => (b.length > a.length ? b : a));
  } else if (reply.includes('```')) {
    // Unterminated fence (e.g. output cut off): take everything after the opening fence.
    code = reply.slice(reply.indexOf('\n', reply.indexOf('```')) + 1);
  } else {
    code = reply;
  }
  code = code.replace(/\s+$/, '');
  if (code.trim() === '') throw new InlineParseError('The model returned no code.');
  return reindent(code, original);
}

/** If the model dropped the selection's base indentation, put it back. */
export function reindent(code: string, original: string): string {
  const base = (s: string) => {
    const lines = s.split('\n').filter(l => l.trim() !== '');
    if (lines.length === 0) return '';
    return lines.reduce((min, l) => {
      const ind = l.match(/^[ \t]*/)![0];
      return ind.length < min.length ? ind : min;
    }, lines[0].match(/^[ \t]*/)![0]);
  };
  const want = base(original);
  const have = base(code);
  if (want === have || want.length < have.length) return code;
  const extra = want.slice(have.length);
  return code
    .split('\n')
    .map(l => (l.trim() === '' ? l : extra + l))
    .join('\n');
}

/** Replace lines [startLine, endLine] of text with the replacement (which has no trailing newline). */
export function spliceLines(text: string, startLine: number, endLine: number, replacement: string): string {
  const lines = text.split('\n');
  lines.splice(startLine, endLine - startLine + 1, ...replacement.split('\n'));
  return lines.join('\n');
}
