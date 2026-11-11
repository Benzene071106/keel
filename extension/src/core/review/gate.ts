import { createHash } from 'node:crypto';
import type { Hunk } from './hunks';

/** A write the agent wants to make, as shown to the reviewer. */
export interface Proposal {
  key: string;
  tool: 'propose_edit' | 'create_file';
  path: string;
  oldText: string;
  newText: string;
  hunks: Hunk[];
}

export interface ReviewDecision {
  accepted: number[];
  note?: string;
}

/**
 * The ReviewGate decides which hunks of a proposal reach disk.
 * Step 4 uses AutoAcceptGate; the DecisionLedger (TrueForge approval-driven review) replaces it later.
 */
export interface ReviewGate {
  decide(p: Proposal): Promise<ReviewDecision>;
  /** True once, if this exact command was approved for this run. Commands never run unapproved. */
  takeCommandApproval(command: string): boolean;
}

export class AutoAcceptGate implements ReviewGate {
  async decide(p: Proposal): Promise<ReviewDecision> {
    return { accepted: p.hunks.map(h => h.index) };
  }
  takeCommandApproval(): boolean {
    return true;
  }
}

/** Stable key for a tool call, computed identically from TrueForge's approval event and the MCP call. */
export function proposalKey(tool: string, args: unknown): string {
  return createHash('sha256').update(tool).update('\0').update(canonicalJson(args)).digest('hex').slice(0, 16);
}

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
