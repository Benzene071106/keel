import { safeRelPath, type EditorHost } from '../host';
import { applyStrEdits, EditApplyError, type StrEdit } from '../mcp/edits';
import { computeHunks } from './hunks';
import { proposalKey, type Proposal } from './gate';

export type WriteTool = 'propose_edit' | 'create_file';
export const WRITE_TOOLS: ReadonlySet<string> = new Set<WriteTool>(['propose_edit', 'create_file']);

export type BuiltProposal = { ok: true; proposal: Proposal } | { ok: false; error: string };

/**
 * Turn a write tool's arguments into a reviewable proposal against the current workspace.
 * Used twice with identical inputs: when TrueForge pauses for approval (to render the review),
 * and when the MCP tool executes (to apply the accepted hunks). Same args -> same key.
 */
export async function buildProposal(host: EditorHost, tool: string, args: unknown): Promise<BuiltProposal> {
  const a = (args ?? {}) as { path?: string; edits?: StrEdit[]; content?: string };
  try {
    if (typeof a.path !== 'string') return { ok: false, error: 'path is required' };
    const rel = safeRelPath(host.root, a.path);
    if (tool === 'propose_edit') {
      if (!Array.isArray(a.edits) || a.edits.length === 0) return { ok: false, error: 'edits must be a non-empty array' };
      const oldText = await host.readText(rel);
      const newText = applyStrEdits(oldText, a.edits);
      return { ok: true, proposal: { key: proposalKey(tool, args), tool, path: rel, oldText, newText, hunks: computeHunks(oldText, newText) } };
    }
    if (tool === 'create_file') {
      if (await host.exists(rel)) return { ok: false, error: `${rel} already exists; use propose_edit.` };
      const newText = String(a.content ?? '');
      return { ok: true, proposal: { key: proposalKey(tool, args), tool, path: rel, oldText: '', newText, hunks: computeHunks('', newText) } };
    }
    return { ok: false, error: `not a write tool: ${tool}` };
  } catch (e) {
    return { ok: false, error: e instanceof EditApplyError ? e.message : String((e as Error).message ?? e) };
  }
}
