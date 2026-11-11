import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { safeRelPath, type EditorHost } from '../host';
import { computeHunks, applyHunks, renderHunk } from '../review/hunks';
import { proposalKey, type ReviewGate } from '../review/gate';
import { applyStrEdits, EditApplyError } from './edits';

/** Hooks the UI listens to (timeline, ledger). All optional. */
export interface ToolEvents {
  onToolCall?(name: string, args: unknown): void;
  onFileWritten?(path: string, appliedHunks: number[], rejectedHunks: number[]): void;
}

const MAX_READ_LINES = 400;

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}
function fail(s: string) {
  return { content: [{ type: 'text' as const, text: s }], isError: true };
}

export function registerTools(server: McpServer, host: EditorHost, gate: ReviewGate, events: ToolEvents = {}): void {
  const root = host.root;

  server.registerTool(
    'read_file',
    {
      description:
        'Read a text file from the workspace with line numbers. Use start_line/end_line for large files (max 400 lines per call).',
      inputSchema: {
        path: z.string().describe('Path relative to the workspace root'),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      events.onToolCall?.('read_file', args);
      try {
        const rel = safeRelPath(root, args.path);
        const lines = (await host.readText(rel)).split('\n');
        const start = Math.max(1, args.start_line ?? 1);
        const end = Math.min(lines.length, args.end_line ?? start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1);
        const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join('\n');
        const more = end < lines.length ? `\n... (${lines.length - end} more lines; call again with start_line=${end + 1})` : '';
        return text(`${rel} (lines ${start}-${end} of ${lines.length})\n${body}${more}`);
      } catch (e) {
        return fail(String((e as Error).message ?? e));
      }
    },
  );

  server.registerTool(
    'list_dir',
    {
      description: 'List files and folders in a workspace directory.',
      inputSchema: { path: z.string().default('.').describe('Directory relative to the workspace root') },
      annotations: { readOnlyHint: true },
    },
    async args => {
      events.onToolCall?.('list_dir', args);
      try {
        const rel = args.path === '.' || args.path === '' ? '' : safeRelPath(root, args.path);
        const entries = await host.listDir(rel);
        return text(entries.map(e => (e.type === 'dir' ? `${e.name}/` : e.name)).join('\n') || '(empty)');
      } catch (e) {
        return fail(String((e as Error).message ?? e));
      }
    },
  );

  server.registerTool(
    'search_code',
    {
      description: 'Search the workspace with a regular expression (ripgrep). Returns path:line: text.',
      inputSchema: {
        pattern: z.string(),
        glob: z.string().optional().describe('Optional file glob, e.g. "*.py" or "docs/**"'),
        max_results: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      events.onToolCall?.('search_code', args);
      try {
        const hits = await host.search(args.pattern, { glob: args.glob, maxResults: args.max_results });
        if (hits.length === 0) return text('No matches.');
        return text(hits.map(h => `${h.path}:${h.line}: ${h.text.trim().slice(0, 200)}`).join('\n'));
      } catch (e) {
        return fail(String((e as Error).message ?? e));
      }
    },
  );

  server.registerTool(
    'propose_edit',
    {
      description:
        'Propose an edit to an existing file as exact search/replace pairs. Each old_str must match the current file exactly once ' +
        '(copy it from read_file without the line numbers). The user reviews every hunk; the result tells you which hunks were applied ' +
        'and which were rejected.',
      inputSchema: {
        path: z.string(),
        edits: z.array(z.object({ old_str: z.string(), new_str: z.string() })).min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async args => {
      events.onToolCall?.('propose_edit', args);
      let rel: string;
      let oldText: string;
      let newText: string;
      try {
        rel = safeRelPath(root, args.path);
        oldText = await host.readText(rel);
        newText = applyStrEdits(oldText, args.edits);
      } catch (e) {
        const msg = e instanceof EditApplyError ? e.message : String((e as Error).message ?? e);
        return fail(`Edit not applied: ${msg}`);
      }
      if (newText === oldText) return text(`No change: the edits leave ${rel} identical.`);
      const hunks = computeHunks(oldText, newText);
      const decision = await gate.decide({ key: proposalKey('propose_edit', args), tool: 'propose_edit', path: rel, oldText, newText, hunks });
      const accepted = new Set(decision.accepted);
      const rejected = hunks.map(h => h.index).filter(i => !accepted.has(i));
      if (accepted.size === 0) {
        return text(`User rejected all ${hunks.length} hunk(s) in ${rel}; nothing was written.${decision.note ? ` User note: ${decision.note}` : ''}`);
      }
      // Re-read right before writing: if the file changed under us, refuse rather than clobber.
      const current = await host.readText(rel);
      if (current !== oldText) return fail(`${rel} changed while the edit was under review; re-read it and propose again.`);
      await host.writeText(rel, applyHunks(oldText, newText, accepted));
      events.onFileWritten?.(rel, [...accepted], rejected);
      const lines = [`Applied ${accepted.size} of ${hunks.length} hunk(s) to ${rel}.`];
      if (rejected.length) {
        lines.push(`Rejected by the user (NOT applied): ${rejected.map(i => i + 1).join(', ')}.`);
        for (const i of rejected) lines.push(renderHunk(hunks[i]));
        if (decision.note) lines.push(`User note: ${decision.note}`);
      }
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'create_file',
    {
      description: 'Create a new file with the given content. Fails if the file already exists (use propose_edit instead).',
      inputSchema: { path: z.string(), content: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async args => {
      events.onToolCall?.('create_file', args);
      let rel: string;
      try {
        rel = safeRelPath(root, args.path);
        if (await host.exists(rel)) return fail(`${rel} already exists; use propose_edit.`);
      } catch (e) {
        return fail(String((e as Error).message ?? e));
      }
      const hunks = computeHunks('', args.content);
      const decision = await gate.decide({ key: proposalKey('create_file', args), tool: 'create_file', path: rel, oldText: '', newText: args.content, hunks });
      if (decision.accepted.length === 0) {
        return text(`User rejected creating ${rel}; nothing was written.${decision.note ? ` User note: ${decision.note}` : ''}`);
      }
      await host.createFile(rel, args.content);
      events.onFileWritten?.(rel, decision.accepted, []);
      return text(`Created ${rel} (${args.content.split('\n').length} lines).`);
    },
  );
}
