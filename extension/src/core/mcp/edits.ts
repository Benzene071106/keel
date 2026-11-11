export interface StrEdit {
  old_str: string;
  new_str: string;
}

export class EditApplyError extends Error {}

/**
 * Apply search/replace edits in order. Each old_str must match exactly once.
 * Falls back to a whitespace-tolerant match (trailing spaces, CRLF) before giving up,
 * and the error tells the model what went wrong so it can retry.
 */
export function applyStrEdits(text: string, edits: StrEdit[]): string {
  let out = text;
  edits.forEach((e, i) => {
    if (e.old_str === '') throw new EditApplyError(`edit ${i + 1}: old_str is empty; use create_file for new files`);
    const count = countOccurrences(out, e.old_str);
    if (count === 1) {
      out = out.replace(e.old_str, () => e.new_str);
      return;
    }
    if (count > 1) {
      throw new EditApplyError(`edit ${i + 1}: old_str matches ${count} places; include more surrounding lines so it is unique`);
    }
    const loose = looseFind(out, e.old_str);
    if (loose) {
      out = out.slice(0, loose.start) + e.new_str + out.slice(loose.end);
      return;
    }
    throw new EditApplyError(`edit ${i + 1}: old_str not found. ${nearestHint(out, e.old_str)}`);
  });
  return out;
}

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  let at = hay.indexOf(needle);
  while (at !== -1) {
    n++;
    at = hay.indexOf(needle, at + needle.length);
  }
  return n;
}

/** Match line-by-line ignoring trailing whitespace. Returns a unique span or undefined. */
function looseFind(hay: string, needle: string): { start: number; end: number } | undefined {
  const norm = (s: string) => s.replace(/\r/g, '').replace(/[ \t]+$/gm, '');
  const hayLines = hay.split('\n');
  const needleLines = norm(needle).split('\n');
  if (needleLines[needleLines.length - 1] === '') needleLines.pop();
  const matches: number[] = [];
  for (let i = 0; i + needleLines.length <= hayLines.length; i++) {
    if (needleLines.every((nl, j) => norm(hayLines[i + j]) === nl)) matches.push(i);
  }
  if (matches.length !== 1) return undefined;
  const startLine = matches[0];
  const start = hayLines.slice(0, startLine).reduce((a, l) => a + l.length + 1, 0);
  const span = hayLines.slice(startLine, startLine + needleLines.length).join('\n');
  const end = start + span.length + (needle.endsWith('\n') ? 1 : 0);
  return { start, end };
}

function nearestHint(hay: string, needle: string): string {
  const first = needle.split('\n').find(l => l.trim().length > 0)?.trim();
  if (!first) return 'Re-read the file and copy old_str exactly.';
  const lines = hay.split('\n');
  const idx = lines.findIndex(l => l.includes(first));
  if (idx === -1) return `Its first line "${first.slice(0, 80)}" does not appear in the file. Re-read the file and copy old_str exactly.`;
  return `Its first line appears at line ${idx + 1}, but the following lines differ. Re-read lines ${Math.max(1, idx - 2)}-${idx + 10} and copy old_str exactly.`;
}
