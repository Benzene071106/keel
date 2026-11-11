import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { contextPack, renderPack, type ContextPack } from '../context/pack';
import type { ContextService } from '../context/service';

export interface ContextEvents {
  onToolCall?(name: string, args: unknown): void;
  /** The Context Ledger: every pack, with per-file reasons and what was dropped. */
  onContextPack?(pack: ContextPack): void;
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const fail = (s: string) => ({ content: [{ type: 'text' as const, text: s }], isError: true });

export function registerContextTools(server: McpServer, ctx: ContextService, events: ContextEvents = {}): void {
  server.registerTool(
    'context_pack',
    {
      description:
        'Call this FIRST for any multi-file task. Returns the files most relevant to the request (code, tests, docs, changelog), ranked, each with the reason it was chosen and the relevant line ranges, packed under a token budget. Use read_file afterwards only for what is missing.',
      inputSchema: {
        request: z.string().describe("The user's request, verbatim"),
        mentions: z.array(z.string()).optional().describe('Paths or symbol names the user explicitly referred to'),
        budget_tokens: z.number().int().min(1000).max(40000).default(12000),
      },
      annotations: { readOnlyHint: true },
    },
    async args => {
      events.onToolCall?.('context_pack', args);
      try {
        const pack = contextPack(await ctx.get(), args.request, { mentions: args.mentions, budget: args.budget_tokens });
        events.onContextPack?.(pack);
        return text(renderPack(pack));
      } catch (e) {
        return fail(String((e as Error).message ?? e));
      }
    },
  );

  server.registerTool(
    'find_symbol',
    {
      description: 'Find where a function, class or method is defined. Accepts "name" or "Class.method". Returns path, line range and signature.',
      inputSchema: { name: z.string() },
      annotations: { readOnlyHint: true },
    },
    async args => {
      events.onToolCall?.('find_symbol', args);
      try {
        const idx = await ctx.get();
        const last = args.name.split('.').pop()!;
        const hits = (idx.symbolsByName.get(last) ?? []).filter(s => !args.name.includes('.') || s.qualname.endsWith(args.name));
        if (hits.length === 0) return text(`No definition of ${args.name} found. Try search_code.`);
        return text(hits.slice(0, 20).map(s => `${s.path}:${s.start + 1}-${s.end + 1} ${s.kind} ${s.qualname}: ${s.signature}`).join('\n'));
      } catch (e) {
        return fail(String((e as Error).message ?? e));
      }
    },
  );

  server.registerTool(
    'repo_map',
    {
      description: 'Outline of top-level symbols per file, optionally under a directory. Cheap orientation before reading files.',
      inputSchema: { path: z.string().default('').describe('Directory prefix, e.g. "src/flask"'), max_files: z.number().int().min(1).max(200).default(40) },
      annotations: { readOnlyHint: true },
    },
    async args => {
      events.onToolCall?.('repo_map', args);
      try {
        const idx = await ctx.get();
        const prefix = args.path.replace(/^\.\/?/, '').replace(/\/?$/, args.path ? '/' : '');
        const out: string[] = [];
        for (const p of [...idx.files.keys()].filter(p => p.startsWith(prefix)).sort()) {
          if (out.length >= args.max_files) break;
          const syms = idx.symbolsIn(p).filter(s => !s.qualname.includes('.'));
          out.push(syms.length ? `${p}: ${syms.slice(0, 25).map(s => s.name).join(', ')}${syms.length > 25 ? ', ...' : ''}` : p);
        }
        return text(out.join('\n') || '(no files)');
      } catch (e) {
        return fail(String((e as Error).message ?? e));
      }
    },
  );
}
