import type { TrueForge } from '@truefoundry/trueforge-sdk';
import { runRequest, type TurnCallbacks, type TurnOutcome } from './turnRunner';

/**
 * TrueForge has no model fallback, and it retries only connect timeouts and 408/429/503
 * (twice). Keel adds the rest: classify each failure, retry transient ones on the same
 * model, and move to the next model for anything that will not fix itself.
 */
export type FailureClass = 'model-fatal' | 'model-transient' | 'not-model';

export function classifyFailure(message: string): FailureClass {
  const m = message.toLowerCase();
  const status = /request failed \((\d{3})\)/.exec(m)?.[1];
  if (status) {
    if (['408', '409', '425', '429', '500', '502', '503', '504', '529'].includes(status)) return 'model-transient';
    return 'model-fatal'; // 400/401/403/404/422...: wrong key, unknown model, bad request
  }
  if (/cannot connect to api|econnrefused|enotfound|eai_again|getaddrinfo|certificate/.test(m)) return 'model-fatal';
  if (/timed? ?out|etimedout|econnreset|socket hang up|overloaded|rate limit/.test(m)) return 'model-transient';
  if (m.startsWith('[model error]')) return 'model-fatal';
  return 'not-model';
}

/**
 * How long the provider asked us to wait, if it said so: Gemini's "Please retry in 18.6s" /
 * "retryDelay": "18s", OpenAI-style "try again in 2.5s" / "in 120ms", or a Retry-After header echoed in the text.
 */
export function retryHintMs(message: string): number | undefined {
  const m = message.toLowerCase();
  const pats: [RegExp, number][] = [
    [/retry(?:ing)? in\s+([\d.]+)\s*ms\b/, 1],
    [/try again in\s+([\d.]+)\s*ms\b/, 1],
    [/retry(?:ing)? in\s+([\d.]+)\s*s(?:ec(?:ond)?s?)?\b/, 1000],
    [/try again in\s+([\d.]+)\s*s(?:ec(?:ond)?s?)?\b/, 1000],
    [/try again in\s+(\d+)m([\d.]+)s/, -1],
    [/"?retrydelay"?\s*[:=]\s*\\?"?([\d.]+)s/, 1000],
    [/retry-after\s*[:=]?\s*"?(\d+(?:\.\d+)?)/, 1000],
  ];
  for (const [re, mult] of pats) {
    const x = re.exec(m);
    if (!x) continue;
    const ms = mult === -1 ? (Number(x[1]) * 60 + Number(x[2])) * 1000 : Number(x[1]) * mult;
    if (Number.isFinite(ms) && ms >= 0) return Math.ceil(ms);
  }
  return undefined;
}

/** A per-day quota will not come back by waiting a minute; move to the next model instead. */
export function isDailyQuota(message: string): boolean {
  return /per ?day|perday|daily (?:limit|quota)|requests per day|\brpd\b/i.test(message);
}

export const MAX_WAIT_MS = 60_000;

export interface FailoverTarget {
  /** Shown to the user, e.g. the agent name. */
  label: string;
  createSession(): Promise<string>;
}

export interface Attempt {
  target: string;
  sessionId?: string;
  outcome: TurnOutcome['status'] | 'threw';
  message?: string;
  class?: FailureClass;
  ms: number;
}

export interface FailoverOptions {
  targets: FailoverTarget[];
  /** Retries on the same target for transient failures. */
  transientRetries?: number;
  /** Retries on the same target when the provider rate-limits us and says how long to wait. */
  rateLimitRetries?: number;
  /** Longest wait we accept from a provider hint; longer (or a daily quota) means switch. */
  maxWaitMs?: number;
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  /** Files changed (and accepted) so far in this run; used to avoid blind replays. */
  changedFiles?: () => string[];
  onSession?(sessionId: string, target: string): void;
  onSwitch?(info: { from: string; to: string; reason: string; class: FailureClass }): void;
  onRetry?(info: { target: string; attempt: number; delayMs: number; reason: string; hinted?: boolean }): void;
}

export type FailoverOutcome = TurnOutcome & { target: string; attempts: Attempt[] };

export function continuationMessage(request: string, changed: string[], fromScratch: boolean): string {
  if (fromScratch && changed.length === 0) return request;
  const note = changed.length
    ? `These files were already changed and accepted by the user: ${changed.join(', ')}. Read them before editing; do not redo those changes.`
    : 'No files were changed yet.';
  return fromScratch
    ? `${request}\n\n[Keel] A previous model failed part-way through this task. ${note} Continue the task from the current state of the workspace.`
    : `[Keel] The previous model call failed with a transient error. ${note} Continue the task from where you left off.`;
}

export async function runWithFailover(
  client: TrueForge,
  request: string,
  cb: TurnCallbacks,
  shouldStop: () => boolean,
  opts: FailoverOptions,
): Promise<FailoverOutcome> {
  const retries = opts.transientRetries ?? 2;
  const rateRetries = opts.rateLimitRetries ?? 4;
  const maxWait = opts.maxWaitMs ?? MAX_WAIT_MS;
  const backoff = opts.backoffMs ?? (n => 600 * 2 ** n);
  // Waits can be up to a minute, so the default sleep wakes early when the user presses Stop.
  const sleep =
    opts.sleep ??
    (ms =>
      new Promise<void>(r => {
        const end = Date.now() + ms;
        const tick = () => (shouldStop() || Date.now() >= end ? r() : setTimeout(tick, Math.min(250, end - Date.now())));
        tick();
      }));
  const changed = opts.changedFiles ?? (() => []);
  const attempts: Attempt[] = [];
  let last: TurnOutcome = { status: 'error', message: 'No model configured', turnIds: [] };

  for (let t = 0; t < opts.targets.length; t++) {
    const target = opts.targets[t];
    let sessionId: string | undefined;
    for (let r = 0; ; r++) {
      if (shouldStop()) return { status: 'cancelled', reason: 'client-cancelled', turnIds: [], target: target.label, attempts };
      const t0 = Date.now();
      try {
        const fresh = !sessionId;
        if (!sessionId) {
          sessionId = await target.createSession();
          opts.onSession?.(sessionId, target.label);
        }
        // First attempt: the request as typed. New session on a fallback: request plus what already changed.
        // Same session after a transient error: just ask it to continue (the request is already in its history).
        const msg = !fresh ? continuationMessage(request, changed(), false) : t === 0 ? request : continuationMessage(request, changed(), true);
        last = await runRequest(client, sessionId, msg, cb, shouldStop);
      } catch (e) {
        last = { status: 'error', message: String((e as Error).message ?? e), turnIds: [] };
        if (shouldStop()) last = { status: 'cancelled', reason: 'client-cancelled', turnIds: [] };
      }
      const cls = last.status === 'error' ? classifyFailure(last.message) : undefined;
      attempts.push({ target: target.label, sessionId, outcome: last.status, message: last.status === 'error' ? last.message : undefined, class: cls, ms: Date.now() - t0 });
      if (last.status !== 'error' || cls === 'not-model') return { ...last, target: target.label, attempts };
      if (cls === 'model-transient') {
        // Honour the provider's own "retry in Ns" (plus a little slack); fall back to exponential backoff.
        const hint = retryHintMs(last.message);
        const tooLong = (hint !== undefined && hint > maxWait) || isDailyQuota(last.message);
        const budget = hint !== undefined ? rateRetries : retries;
        if (!tooLong && r < budget) {
          const delayMs = Math.min(maxWait, Math.max(backoff(r), hint !== undefined ? hint + 500 : 0));
          opts.onRetry?.({ target: target.label, attempt: r + 1, delayMs, reason: last.message, hinted: hint !== undefined });
          await sleep(delayMs);
          continue;
        }
      }
      break; // fatal, or transient retries used up: next target
    }
    const next = opts.targets[t + 1];
    if (next) opts.onSwitch?.({ from: target.label, to: next.label, reason: last.status === 'error' ? last.message : '', class: classifyFailure(last.status === 'error' ? last.message : '') });
  }
  return { ...last, target: opts.targets[opts.targets.length - 1]?.label ?? '', attempts };
}

/** Same policy for inline edits (no writes happen before the user accepts, so a retry is always safe). */
export async function withInlineFailover<R extends { status: string; message?: string }>(
  agents: string[],
  run: (agent: string) => Promise<R>,
  onSwitch?: (from: string, to: string, reason: string) => void,
): Promise<R & { agent: string }> {
  let last: R | undefined;
  for (let i = 0; i < agents.length; i++) {
    last = await run(agents[i]);
    if (last.status !== 'error' || classifyFailure(last.message ?? '') === 'not-model' || i === agents.length - 1) return { ...last, agent: agents[i] };
    onSwitch?.(agents[i], agents[i + 1], last.message ?? '');
  }
  return { ...(last as R), agent: agents[agents.length - 1] };
}
