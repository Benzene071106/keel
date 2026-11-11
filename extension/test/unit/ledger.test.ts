import { describe, expect, it } from 'vitest';
import type { DirEntry, EditorHost, SearchHit } from '../../src/core/host';
import { DecisionLedger, type Reviewer } from '../../src/core/review/ledger';
import { JournaledHost } from '../../src/core/review/journal';
import { buildProposal } from '../../src/core/review/proposal';
import { applyHunks } from '../../src/core/review/hunks';
import type { PendingCall } from '../../src/core/trueforge/turnRunner';

class MemHost implements EditorHost {
  root = '/ws';
  files = new Map<string, string>();
  async readText(p: string) {
    const t = this.files.get(p);
    if (t === undefined) throw new Error(`ENOENT ${p}`);
    return t;
  }
  async exists(p: string) {
    return this.files.has(p);
  }
  async listDir(): Promise<DirEntry[]> {
    return [];
  }
  async search(): Promise<SearchHit[]> {
    return [];
  }
  async writeText(p: string, t: string) {
    this.files.set(p, t);
  }
  async createFile(p: string, t: string) {
    if (this.files.has(p)) throw new Error('exists');
    this.files.set(p, t);
  }
  async deleteFile(p: string) {
    this.files.delete(p);
  }
  log() {}
}

const SRC = 'a = 1\nb = 2\nc = 3\nd = 4\n';
const editArgs = { path: 'm.py', edits: [{ old_str: 'a = 1', new_str: 'a = 10' }, { old_str: 'd = 4', new_str: 'd = 40' }] };
const call = (toolName: string, args: unknown): PendingCall => ({ threadId: 'main', toolCallId: 'c1', toolName, args, rawArgs: JSON.stringify(args) });
const reviewerAccepting = (pick: (n: number) => number[]): Reviewer => ({
  review: async ps => ps.map(p => ({ accepted: pick(p.hunks.length) })),
});

describe('DecisionLedger', () => {
  it('allows the call and hands the stored per-hunk decision to the tool', async () => {
    const host = new MemHost();
    host.files.set('m.py', SRC);
    const ledger = new DecisionLedger(host, reviewerAccepting(() => [1]));
    ledger.begin();
    expect(await ledger.onApproval([call('propose_edit', editArgs)])).toEqual([{ status: 'allow' }]);
    const built = await buildProposal(host, 'propose_edit', editArgs);
    if (!built.ok) throw new Error(built.error);
    const d = await ledger.decide(built.proposal);
    expect(d.accepted).toEqual([1]);
    expect(applyHunks(built.proposal.oldText, built.proposal.newText, new Set(d.accepted))).toBe('a = 1\nb = 2\nc = 3\nd = 40\n');
  });

  it('denies with a reason when every hunk is rejected', async () => {
    const host = new MemHost();
    host.files.set('m.py', SRC);
    const ledger = new DecisionLedger(host, reviewerAccepting(() => []));
    const [a] = await ledger.onApproval([call('propose_edit', editArgs)]);
    expect(a.status).toBe('deny');
  });

  it('fails closed: no recorded decision means nothing is written', async () => {
    const host = new MemHost();
    host.files.set('m.py', SRC);
    const ledger = new DecisionLedger(host, reviewerAccepting(n => [...Array(n).keys()]));
    const built = await buildProposal(host, 'propose_edit', editArgs);
    if (!built.ok) throw new Error(built.error);
    expect((await ledger.decide(built.proposal)).accepted).toEqual([]);
  });

  it('cancel drops approved-but-not-yet-run decisions', async () => {
    const host = new MemHost();
    host.files.set('m.py', SRC);
    const ledger = new DecisionLedger(host, reviewerAccepting(n => [...Array(n).keys()]));
    ledger.begin();
    await ledger.onApproval([call('propose_edit', editArgs)]);
    ledger.cancel();
    const built = await buildProposal(host, 'propose_edit', editArgs);
    if (!built.ok) throw new Error(built.error);
    expect((await ledger.decide(built.proposal)).accepted).toEqual([]);
  });

  it('lets broken edits through so the model sees the real error', async () => {
    const host = new MemHost();
    host.files.set('m.py', SRC);
    const ledger = new DecisionLedger(host, reviewerAccepting(() => []));
    const [a] = await ledger.onApproval([call('propose_edit', { path: 'm.py', edits: [{ old_str: 'zzz', new_str: 'y' }] })]);
    expect(a).toEqual({ status: 'allow' });
  });
});

describe('JournaledHost', () => {
  it('reverts edits and created files of a run', async () => {
    const inner = new MemHost();
    inner.files.set('m.py', SRC);
    const host = new JournaledHost(inner);
    host.beginRun();
    await host.writeText('m.py', 'changed once\n');
    await host.writeText('m.py', 'changed twice\n');
    await host.createFile('new.py', 'x = 1\n');
    const r = await host.revertRun();
    expect(r.reverted.sort()).toEqual(['m.py', 'new.py']);
    expect(inner.files.get('m.py')).toBe(SRC);
    expect(inner.files.has('new.py')).toBe(false);
  });

  it('does not clobber a file the user edited after the run', async () => {
    const inner = new MemHost();
    inner.files.set('m.py', SRC);
    const host = new JournaledHost(inner);
    host.beginRun();
    await host.writeText('m.py', 'agent\n');
    inner.files.set('m.py', 'user edit\n');
    const r = await host.revertRun();
    expect(r.skipped).toEqual(['m.py']);
    expect(inner.files.get('m.py')).toBe('user edit\n');
  });
});
