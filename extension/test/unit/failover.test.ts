import { describe, expect, it } from 'vitest';
import { classifyFailure, continuationMessage, isDailyQuota, retryHintMs, runWithFailover, withInlineFailover } from '../../src/core/trueforge/failover';

/** Fake TrueForge client: each session id maps to a queue of turn results. */
function fakeClient(script: Record<string, ({ error: string } | { output: string })[]>) {
  const sent: { session: string; text: string }[] = [];
  const client = {
    sessions: {
      createTurnStream: async (session: string, body: { input: { content: string }[] }) => {
        sent.push({ session, text: body.input[0].content });
        const r = script[session].shift()!;
        const state = 'error' in r ? { status: 'error', message: r.error } : { status: 'completed', output: { content: r.output } };
        return {
          withMetadata: async function* () {
            yield { data: { id: 'e1', type: 'turn.created', turnId: 't' } };
            yield { data: { id: 'e2', type: 'turn.done', state } };
          },
        };
      },
    },
  };
  return { client: client as never, sent };
}
const target = (label: string) => ({ label, createSession: async () => label });
const noSleep = async () => {};

describe('classifyFailure', () => {
  it('separates fatal, transient and non-model errors', () => {
    expect(classifyFailure('[Model Error] Request failed (401): Incorrect API key provided')).toBe('model-fatal');
    expect(classifyFailure('[Model Error] Cannot connect to API: connect ECONNREFUSED 127.0.0.1:9')).toBe('model-fatal');
    expect(classifyFailure('[Model Error] Request failed (404): model not found')).toBe('model-fatal');
    expect(classifyFailure('[Model Error] Request failed (500): upstream exploded')).toBe('model-transient');
    expect(classifyFailure('[Model Error] Request failed (429): slow down')).toBe('model-transient');
    expect(classifyFailure('[Model Error] request timed out')).toBe('model-transient');
    expect(classifyFailure('Iteration limit reached')).toBe('not-model');
  });
});

describe('runWithFailover', () => {
  it('switches immediately on a fatal error and replays the request when nothing was written', async () => {
    const { client, sent } = fakeClient({ a: [{ error: '[Model Error] Request failed (401): bad key' }], b: [{ output: 'ok' }] });
    const switches: string[] = [];
    const out = await runWithFailover(client, 'do it', {}, () => false, { targets: [target('a'), target('b')], sleep: noSleep, onSwitch: s => switches.push(`${s.from}>${s.to}`) });
    expect(out.status).toBe('done');
    expect(out.target).toBe('b');
    expect(switches).toEqual(['a>b']);
    expect(sent).toEqual([{ session: 'a', text: 'do it' }, { session: 'b', text: 'do it' }]);
  });

  it('retries a transient error on the same session before switching', async () => {
    const { client, sent } = fakeClient({ a: [{ error: '[Model Error] Request failed (500): x' }, { output: 'recovered' }], b: [] });
    const out = await runWithFailover(client, 'do it', {}, () => false, { targets: [target('a'), target('b')], sleep: noSleep });
    expect(out.status).toBe('done');
    expect(out.target).toBe('a');
    expect(out.attempts.map(a => a.outcome)).toEqual(['error', 'done']);
    expect(sent[1].session).toBe('a');
    expect(sent[1].text).toMatch(/transient error/);
  });

  it('never replays blindly after a write: the fallback is told what already changed', async () => {
    const e = { error: '[Model Error] Request failed (503): x' };
    const { client, sent } = fakeClient({ a: [e, e, e], b: [{ output: 'finished' }] });
    const out = await runWithFailover(client, 'do it', {}, () => false, { targets: [target('a'), target('b')], sleep: noSleep, changedFiles: () => ['src/x.py'] });
    expect(out.target).toBe('b');
    expect(out.attempts).toHaveLength(4);
    const toB = sent.find(s => s.session === 'b')!.text;
    expect(toB).toContain('do it');
    expect(toB).toContain('src/x.py');
    expect(toB).toMatch(/do not redo/);
  });

  it('does not fail over on non-model errors, and reports the last error when every model fails', async () => {
    const one = fakeClient({ a: [{ error: 'Iteration limit reached' }], b: [{ output: 'never' }] });
    expect((await runWithFailover(one.client, 'x', {}, () => false, { targets: [target('a'), target('b')], sleep: noSleep })).target).toBe('a');
    const f = { error: '[Model Error] Request failed (401): k' };
    const all = fakeClient({ a: [f], b: [f] });
    const out = await runWithFailover(all.client, 'x', {}, () => false, { targets: [target('a'), target('b')], sleep: noSleep });
    expect(out.status).toBe('error');
    expect(out.attempts).toHaveLength(2);
  });

  it('stops without calling a model once cancelled', async () => {
    const { client, sent } = fakeClient({ a: [{ output: 'x' }] });
    const out = await runWithFailover(client, 'x', {}, () => true, { targets: [target('a')] });
    expect(out.status).toBe('cancelled');
    expect(sent).toHaveLength(0);
  });
});

const GEMINI_429 =
  '[Model Error] Request failed (429): You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, model: gemini-3.8-flash. Please retry in 18.617689352s. [{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"18s"}]';

describe('provider retry hints', () => {
  it('reads the wait the provider asked for', () => {
    expect(retryHintMs(GEMINI_429)).toBe(18618);
    expect(retryHintMs('Request failed (429): {"retryDelay": "7s"}')).toBe(7000);
    expect(retryHintMs('Rate limit reached. Please try again in 2.5s.')).toBe(2500);
    expect(retryHintMs('Rate limit reached. Please try again in 120ms.')).toBe(120);
    expect(retryHintMs('Please try again in 1m30s')).toBe(90000);
    expect(retryHintMs('retry-after: 12')).toBe(12000);
    expect(retryHintMs('[Model Error] Request failed (500): x')).toBeUndefined();
  });

  it('spots daily quotas', () => {
    expect(isDailyQuota('quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier')).toBe(true);
    expect(isDailyQuota(GEMINI_429)).toBe(false);
  });

  it('waits as long as the provider says, with more patience for rate limits', async () => {
    const { client } = fakeClient({ a: [{ error: GEMINI_429 }, { error: GEMINI_429 }, { error: GEMINI_429 }, { output: 'ok' }], b: [] });
    const waits: number[] = [];
    const out = await runWithFailover(client, 'x', {}, () => false, { targets: [target('a'), target('b')], sleep: async ms => void waits.push(ms) });
    expect(out.target).toBe('a');
    expect(out.status).toBe('done');
    expect(waits).toEqual([19118, 19118, 19118]);
  });

  it('switches instead of waiting when the wait is too long or the quota is daily', async () => {
    const long = '[Model Error] Request failed (429): quota. Please retry in 3600s.';
    const daily = '[Model Error] Request failed (429): quotaId GenerateRequestsPerDayPerProjectPerModel. Please retry in 10s.';
    for (const err of [long, daily]) {
      const { client } = fakeClient({ a: [{ error: err }], b: [{ output: 'ok' }] });
      const waits: number[] = [];
      const out = await runWithFailover(client, 'x', {}, () => false, { targets: [target('a'), target('b')], sleep: async ms => void waits.push(ms) });
      expect(out.target).toBe('b');
      expect(waits).toEqual([]);
    }
  });

  it('wakes from a long wait when the user presses Stop', async () => {
    const { client } = fakeClient({ a: [{ error: '[Model Error] Request failed (429): Please retry in 30s.' }], b: [] });
    let stop = false;
    setTimeout(() => (stop = true), 300);
    const t0 = Date.now();
    const out = await runWithFailover(client, 'x', {}, () => stop, { targets: [target('a'), target('b')] });
    expect(out.status).toBe('cancelled');
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('inline failover', () => {
  it('falls back on a model error and reports which agent answered', async () => {
    const r = await withInlineFailover(['p', 'f'], async a => (a === 'p' ? { status: 'error', message: '[Model Error] Request failed (401): k' } : { status: 'ok' }));
    expect(r).toMatchObject({ status: 'ok', agent: 'f' });
  });
  it('keeps a parse error on the primary', async () => {
    const r = await withInlineFailover(['p', 'f'], async () => ({ status: 'error', message: 'Model returned no code' }));
    expect(r.agent).toBe('p');
  });
});

describe('continuationMessage', () => {
  it('is the plain request for a clean first attempt on a fallback', () => {
    expect(continuationMessage('r', [], true)).toBe('r');
  });
});
