import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { safeRelPath, type EditorHost } from '../host';
import { applyHunks, renderHunk } from '../review/hunks';
import type { ReviewGate } from '../review/gate';
import { buildProposal } from '../review/proposal';
import { classifyCommand } from '../command/policy';

/** Hooks the UI listens to (timeline, ledger). All optional. */
export interface ToolEvents {
  /** A tool call that returned an error to the model. */
  onToolError?(message: string): void;
  onCommand?(command: string, result: { exitCode: number | null; timedOut: boolean; ms: number }): void;
  onToolCall?(name: string, args: unknown): void;
  onFileWritten?(path: string, appliedHunks: number[], rejectedHunks: number[]): void;
}

const MAX_READ_LINES = 400;

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}
function failResult(s: string) {
  return { content: [{ type: 'text' as const, text: s }], isError: true };
}

export function registerTools(server: McpServer, host: EditorHost, gate: ReviewGate, events: ToolEvents = {}): void {
  const root = host.root;
  // Every failed call is reported, so the UI never shows a silent no-op.
  const fail = (s: string) => {
    events.onToolError?.(s);
    return failResult(s);
  };

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

  async function reviewAndWrite(tool: 'propose_edit' | 'create_file', args: unknown) {
    const built = await buildProposal(host, tool, args);
    if (!built.ok) return fail(`Edit not applied: ${built.error}`);
    const p = built.proposal;
    if (p.newText === p.oldText && tool === 'propose_edit') {
      events.onToolError?.(`No change: the edits leave ${p.path} identical.`);
      return text(`No change: the edits leave ${p.path} identical.`);
    }
    const decision = await gate.decide(p);
    const accepted = new Set(decision.accepted);
    const rejected = p.hunks.map(h => h.index).filter(i => !accepted.has(i));
    if (accepted.size === 0) {
      return text(`Nothing was written to ${p.path}: ${decision.note ?? `the user rejected all ${p.hunks.length} hunk(s).`}`);
    }
    if (tool === 'create_file') {
      await host.createFile(p.path, p.newText);
      events.onFileWritten?.(p.path, [...accepted], []);
      return text(`Created ${p.path} (${p.newText.split('\n').length} lines).`);
    }
    // Re-read right before writing: if the file changed during review, refuse rather than clobber.
    if ((await host.readText(p.path)) !== p.oldText) return fail(`${p.path} changed while the edit was under review; re-read it and propose again.`);
    await host.writeText(p.path, applyHunks(p.oldText, p.newText, accepted));
    events.onFileWritten?.(p.path, [...accepted], rejected);
    const lines = [`Applied ${accepted.size} of ${p.hunks.length} hunk(s) to ${p.path}.`];
    if (rejected.length) {
      lines.push(`Rejected by the user (NOT applied): hunk ${rejected.map(i => i + 1).join(', ')}.`);
      for (const i of rejected) lines.push(renderHunk(p.hunks[i]));
    }
    if (decision.note) lines.push(`User note: ${decision.note}`);
    return text(lines.join('\n'));
  }

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
      return reviewAndWrite('propose_edit', args);
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
      return reviewAndWrite('create_file', args);
    },
  );

  server.registerTool(
    'run_command',
    {
      description:
        'Run a shell command in the workspace root and return its exit code and output (last 12k characters). Use it to run the tests you wrote or changed, e.g. "python -m pytest tests/test_cli.py -q". Test runners and read-only git commands run at once; anything else asks the user; destructive commands are refused.',
      inputSchema: {
        command: z.string().describe('One command. No chaining with ; && | or redirection unless it is really needed.'),
        timeout_s: z.number().int().min(1).max(600).default(120),
      },
    },
    async args => {
      events.onToolCall?.('run_command', args);
      if (!host.runCommand) return fail('This workspace cannot run commands.');
      const blocked = classifyCommand(args.command);
      if (blocked.class === 'blocked') return fail(`Not run: ${blocked.reason}.`);
      // Fail closed: only a command the user (or the allowlist) approved for this run may execute.
      if (!gate.takeCommandApproval(args.command)) return fail('Not run: this command was not approved.');
      try {
        const r = await host.runCommand(args.command, { timeoutMs: args.timeout_s * 1000 });
        events.onCommand?.(args.command, r);
        const status = r.timedOut ? `timed out after ${args.timeout_s} s` : r.killed ? 'stopped by the user' : `exit code ${r.exitCode}`;
        return text(`$ ${args.command}\n(${status}, ${(r.ms / 1000).toFixed(1)} s)\n${r.output || '(no output)'}`);
      } catch (e) {
        return fail(String((e as Error).message ?? e));
      }
    },
  );
}
