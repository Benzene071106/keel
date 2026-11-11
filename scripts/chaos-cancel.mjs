#!/usr/bin/env node
// Chaos test for cancellation: run a multi-file agent task and press Stop at a random moment, N times.
// After every run, each file must be either untouched or exactly what the run journal recorded as
// fully written. Any other state (half-applied edit, stray temp file) is a failure.
//
//   node scripts/chaos-cancel.mjs --root /path/to/flask [--runs 30] [--max-ms 6000]
// Requires TrueForge + mock model running and keel-agent synced to mock/slow-multi-edit.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 ? process.argv[i + 1] : d;
};
const root = arg('root');
const runs = Number(arg('runs', 30));
const maxMs = Number(arg('max-ms', 6000));
const ext = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });

let failures = 0;
const tally = { clean: 0, partialRun: 0, fullRun: 0 };
for (let i = 1; i <= runs; i++) {
  git('checkout', '-q', '.');
  git('clean', '-fdq');
  const cancelAt = 200 + Math.floor(Math.random() * maxMs);
  const reviewDelay = Math.floor(Math.random() * 1500);
  const journal = path.join(os.tmpdir(), `keel-chaos-${process.pid}-${i}.json`);
  spawnSync('npx', ['tsx', 'src/node/headless.ts', '--root', root, '--agent', 'keel-agent', '--cancel-after-ms', String(cancelAt), '--review-delay-ms', String(reviewDelay), '--journal-out', journal, 'make the three edits'], {
    cwd: ext,
    encoding: 'utf8',
    timeout: 60000,
  });
  const touched = fs.existsSync(journal) ? JSON.parse(fs.readFileSync(journal, 'utf8')) : [];
  const expected = new Map(touched.map(c => [c.path, c.post]));
  const changed = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).map(l => l.slice(3));
  const problems = [];
  for (const f of changed) {
    if (f.includes('.keel-tmp')) problems.push(`stray temp file ${f}`);
    else if (!expected.has(f)) problems.push(`${f} changed but not in journal`);
    else if (fs.readFileSync(path.join(root, f), 'utf8') !== expected.get(f)) problems.push(`${f} differs from its journaled full write`);
  }
  for (const [f] of expected) if (!changed.includes(f)) problems.push(`${f} journaled but unchanged on disk`);
  const kind = changed.length === 0 ? 'clean' : changed.length === 3 ? 'fullRun' : 'partialRun';
  tally[kind]++;
  if (problems.length) failures++;
  console.log(`run ${String(i).padStart(2)}: stop@${cancelAt}ms review=${reviewDelay}ms -> ${changed.length} file(s) changed ${problems.length ? `FAIL ${problems.join('; ')}` : 'OK'}`);
  fs.rmSync(journal, { force: true });
}
git('checkout', '-q', '.');
console.log(`\n${runs - failures}/${runs} consistent. untouched=${tally.clean} some-files=${tally.partialRun} all-files=${tally.fullRun}`);
process.exit(failures ? 1 : 0);
