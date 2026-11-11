/**
 * Headless inline edit (same core as the extension's Ctrl/Cmd+Alt+K):
 *   npx tsx src/node/headlessInline.ts --root ../flask --file src/flask/helpers.py --lines 28-33 \
 *       [--agent keel-inline] [--accept 1,2|all|none] "instruction"
 */
import { NodeHost } from './nodeHost';
import { createClient } from '../core/trueforge/client';
import { runInline } from '../core/inline/runInline';
import { applyHunks, computeHunks, renderHunk } from '../core/review/hunks';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

async function main() {
  const host = new NodeHost(arg('root'));
  const file = arg('file');
  const [a, b] = arg('lines').split('-').map(Number);
  const agent = arg('agent', 'keel-inline');
  const accept = arg('accept', 'all');
  const instruction = process.argv[process.argv.length - 1];
  const client = createClient(arg('trueforge', 'http://localhost:8790'));
  const fileText = await host.readText(file);

  const t0 = Date.now();
  let first = 0;
  let stopped = false;
  let sessionId: string | undefined;
  const cancelAfter = Number(arg('cancel-after-ms', '0'));
  if (cancelAfter > 0) {
    setTimeout(() => {
      stopped = true;
      console.log(`\n[inline] cancelling after ${cancelAfter} ms`);
      if (sessionId) void client.sessions.cancel(sessionId);
    }, cancelAfter);
  }
  const res = await runInline(client, agent, { path: file, languageId: 'python', fileText, startLine: a - 1, endLine: b - 1, instruction }, {
    onSession: id => (sessionId = id),
    shouldStop: () => stopped,
    onText: t => {
      if (!first) first = Date.now() - t0;
      process.stdout.write(t);
    },
  });
  console.log(`\n[inline] ${res.status} (first token ${first} ms, total ${Date.now() - t0} ms)`);
  if (res.status !== 'ok') {
    console.log(`[inline] ${JSON.stringify(res)}`);
    process.exit(2);
  }
  const hunks = computeHunks(fileText, res.newFileText);
  hunks.forEach(h => console.log(renderHunk(h)));
  const acc = new Set(accept === 'all' ? hunks.map(h => h.index) : accept === 'none' ? [] : accept.split(',').map(n => Number(n) - 1));
  if (acc.size) await host.writeText(file, applyHunks(fileText, res.newFileText, acc));
  console.log(`[inline] accepted hunks: ${[...acc].map(i => i + 1).join(',') || 'none'}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
