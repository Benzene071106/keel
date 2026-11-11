import type { EditorHost } from '../host';
import type { ApprovalAnswer, PendingCall } from '../trueforge/turnRunner';
import type { Proposal, ReviewDecision, ReviewGate } from './gate';
import { buildProposal, WRITE_TOOLS } from './proposal';

/** The UI that shows proposals and collects per-hunk decisions. */
export interface Reviewer {
  /** Show all proposals of one approval pause; resolve with one decision per proposal (same order). */
  review(proposals: Proposal[]): Promise<ReviewDecision[]>;
}

export interface CommandPolicy {
  /** Decide a run_command approval without asking (allowlist), or undefined to ask the user. */
  autoDecide?(command: string): ApprovalAnswer | undefined;
  ask?(command: string): Promise<ApprovalAnswer>;
}

/**
 * DecisionLedger joins TrueForge tool approval to per-hunk review.
 *
 * 1. TrueForge pauses on a gated write tool -> onApproval(): build the proposal, show the Reviewer,
 *    store the per-hunk decision under the proposal key, answer allow (>=1 hunk) or deny (none).
 * 2. TrueForge runs the approved tool on our MCP server -> decide(): look the key up and return the
 *    stored decision, so only accepted hunks are written.
 *
 * A key with no stored decision is never written (fail closed). cancel() drops all decisions, so a
 * tool call that arrives after the user pressed Stop writes nothing.
 */
export class DecisionLedger implements ReviewGate {
  private decisions = new Map<string, ReviewDecision>();
  private cancelled = false;

  constructor(
    private readonly host: EditorHost,
    private readonly reviewer: Reviewer,
    private readonly commands: CommandPolicy = {},
  ) {}

  /** Start a new user request. */
  begin(): void {
    this.decisions.clear();
    this.cancelled = false;
  }

  cancel(): void {
    this.cancelled = true;
    this.decisions.clear();
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  async decide(p: Proposal): Promise<ReviewDecision> {
    if (this.cancelled) return { accepted: [], note: 'The run was cancelled by the user.' };
    const d = this.decisions.get(p.key);
    if (!d) return { accepted: [], note: 'No review decision was recorded for this edit; nothing was written.' };
    this.decisions.delete(p.key);
    return d;
  }

  /** TurnCallbacks.onApproval implementation. */
  async onApproval(calls: PendingCall[]): Promise<ApprovalAnswer[]> {
    const answers: ApprovalAnswer[] = new Array(calls.length);
    const toReview: { i: number; proposal: Proposal }[] = [];

    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      if (WRITE_TOOLS.has(c.toolName)) {
        const built = await buildProposal(this.host, c.toolName, c.args);
        if (!built.ok) {
          // Let it run: the tool will fail with the same error and the model can correct itself.
          answers[i] = { status: 'allow' };
        } else if (built.proposal.hunks.length === 0) {
          answers[i] = { status: 'allow' };
        } else {
          toReview.push({ i, proposal: built.proposal });
        }
      } else if (c.toolName === 'run_command') {
        const cmd = String((c.args as { command?: string })?.command ?? '');
        answers[i] = this.commands.autoDecide?.(cmd) ?? (this.commands.ask ? await this.commands.ask(cmd) : { status: 'deny', reason: 'Command not allowed.' });
      } else {
        answers[i] = { status: 'allow' };
      }
    }

    if (toReview.length > 0) {
      const decisions = this.cancelled ? toReview.map((): ReviewDecision => ({ accepted: [] })) : await this.reviewer.review(toReview.map(r => r.proposal));
      toReview.forEach((r, j) => {
        const d = decisions[j] ?? { accepted: [] };
        if (!this.cancelled && d.accepted.length > 0) {
          this.decisions.set(r.proposal.key, d);
          answers[r.i] = { status: 'allow' };
        } else {
          answers[r.i] = {
            status: 'deny',
            reason: `The user rejected every hunk of the change to ${r.proposal.path}.${d.note ? ` Note: ${d.note}.` : ''} Do not re-propose it unchanged.`,
          };
        }
      });
    }
    return answers;
  }
}
