import { isEventDelta, mergeEventDelta, type TrueForge, type TrueForgeApi } from '@truefoundry/trueforge-sdk';

type Event = TrueForgeApi.TurnStreamingEvent;

/** A paused tool call, resolved to its name and parsed arguments. */
export interface PendingCall {
  threadId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  rawArgs: string;
}

export type ApprovalAnswer = { status: 'allow' } | { status: 'deny'; reason?: string };

export interface TurnCallbacks {
  /** Every non-delta event, plus each delta after it has been merged into its base. */
  onEvent?(event: Event, merged: Event | undefined): void;
  /** Text tokens of the root agent as they arrive. */
  onText?(chunk: string, threadId: string | null | undefined): void;
  /** Decide every paused call. Called once per pause with all pending calls. */
  onApproval?(calls: PendingCall[]): Promise<ApprovalAnswer[]>;
}

export type TurnOutcome =
  | { status: 'done'; output: string; turnIds: string[] }
  | { status: 'cancelled'; reason: string; turnIds: string[] }
  | { status: 'error'; message: string; turnIds: string[] };

/**
 * Drive one user request to completion: stream a turn, and whenever it pauses for approval,
 * ask the callback and resume with a new turn. Ends on done (no pending actions), cancel, or error.
 */
export async function runRequest(
  client: TrueForge,
  sessionId: string,
  userMessage: string,
  cb: TurnCallbacks,
  shouldStop: () => boolean = () => false,
): Promise<TurnOutcome> {
  const index = new Map<string, Event>();
  const turnIds: string[] = [];
  let input: TrueForgeApi.TurnInputItem[] = [{ type: 'user.message', content: userMessage } as TrueForgeApi.TurnInputItem];

  for (;;) {
    const pending: TrueForgeApi.ToolApprovalRequiredEvent[] = [];
    let done: TrueForgeApi.TurnDoneEvent | undefined;
    const stream = await client.sessions.createTurnStream(sessionId, { input });
    for await (const { data: ev } of stream.withMetadata()) {
      if (isEventDelta(ev)) {
        const base = index.get(ev.id);
        if (base) mergeEventDelta(base, ev);
        const content = (ev as { content?: string }).content;
        if (content) cb.onText?.(content, (ev as { threadId?: string }).threadId);
        cb.onEvent?.(ev, base);
        continue;
      }
      index.set(ev.id, ev);
      if (ev.type === 'turn.created') turnIds.push(ev.turnId);
      if (ev.type === 'tool.approval_required') pending.push(ev);
      if (ev.type === 'turn.done') done = ev;
      cb.onEvent?.(ev, ev);
    }

    const state = done?.state as { status: string; output?: { content?: string } | null; message?: string; reason?: string } | undefined;
    if (!state) return { status: 'error', message: 'Stream ended without turn.done', turnIds };
    if (state.status === 'error') return { status: 'error', message: state.message ?? 'unknown error', turnIds };
    if (state.status === 'cancelled') return { status: 'cancelled', reason: state.reason ?? 'cancelled', turnIds };
    if (pending.length === 0) return { status: 'done', output: state.output?.content ?? '', turnIds };
    if (shouldStop()) return { status: 'cancelled', reason: 'client-cancelled', turnIds };

    const calls: PendingCall[] = [];
    for (const p of pending) {
      for (const ref of p.toolCalls) {
        const msg = index.get(ref.sourceEventId) as TrueForgeApi.ModelMessageEvent | undefined;
        const call = msg?.toolCalls?.find(tc => tc.id === ref.id);
        const rawArgs = call?.function?.arguments ?? '{}';
        let args: unknown = {};
        try {
          args = JSON.parse(rawArgs || '{}');
        } catch {
          args = {};
        }
        calls.push({ threadId: p.threadId ?? 'main', toolCallId: ref.id, toolName: call?.toolInfo?.name ?? call?.function?.name ?? 'unknown', args, rawArgs });
      }
    }
    const answers = cb.onApproval ? await cb.onApproval(calls) : calls.map(() => ({ status: 'allow' as const }));
    if (shouldStop()) return { status: 'cancelled', reason: 'client-cancelled', turnIds };
    input = calls.map((c, i) => ({
      type: 'user.tool_approval',
      threadId: c.threadId,
      toolCallId: c.toolCallId,
      approval: answers[i] ?? { status: 'deny', reason: 'no decision' },
    })) as TrueForgeApi.TurnInputItem[];
  }
}
