import type { TrueForge } from '@truefoundry/trueforge-sdk';
import { runRequest, type TurnOutcome } from '../trueforge/turnRunner';
import { buildInlinePrompt, InlineParseError, parseInlineOutput, selectionText, spliceLines, type InlineRequest } from './inline';

export type InlineResult =
  | { status: 'ok'; newFileText: string; replacement: string; sessionId: string }
  | { status: 'cancelled'; sessionId?: string }
  | { status: 'error'; message: string; sessionId?: string };

export interface InlineHooks {
  onSession?(sessionId: string): void;
  onText?(chunk: string): void;
  shouldStop?(): boolean;
}

/** One inline edit on one TrueForge agent. Never touches the workspace: it only computes the proposal. */
export async function runInline(client: TrueForge, agentName: string, req: InlineRequest, hooks: InlineHooks = {}): Promise<InlineResult> {
  let sessionId: string | undefined;
  try {
    const { data: session } = await client.sessions.create({ agent: { name: agentName } });
    sessionId = session.id;
    hooks.onSession?.(session.id);
    let streamed = '';
    const outcome: TurnOutcome = await runRequest(
      client,
      session.id,
      buildInlinePrompt(req),
      {
        onText: (t, thread) => {
          if (thread && thread !== 'main') return;
          streamed += t;
          hooks.onText?.(t);
        },
        // The inline agent has no write tools; deny anything unexpected.
        onApproval: async calls => calls.map(() => ({ status: 'deny' as const, reason: 'Inline edit cannot run tools.' })),
      },
      hooks.shouldStop,
    );
    if (outcome.status === 'cancelled') return { status: 'cancelled', sessionId };
    if (outcome.status === 'error') return { status: 'error', message: outcome.message, sessionId };
    const reply = outcome.output || streamed;
    const replacement = parseInlineOutput(reply, selectionText(req));
    return { status: 'ok', replacement, newFileText: spliceLines(req.fileText, req.startLine, req.endLine, replacement), sessionId };
  } catch (e) {
    if (hooks.shouldStop?.()) return { status: 'cancelled', sessionId };
    const message = e instanceof InlineParseError ? e.message : String((e as Error).message ?? e);
    return { status: 'error', message, sessionId };
  }
}
