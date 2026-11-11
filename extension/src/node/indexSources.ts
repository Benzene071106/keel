import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RepoIndexSources } from '../core/context/repoIndex';

const run = (cwd: string, args: string[]) =>
  new Promise<string>((res, rej) =>
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, out) => (err ? rej(err) : res(out))),
  );

/** Index sources backed by git + the filesystem. Used by the headless runner, tests and the extension. */
export function gitIndexSources(root: string, historyDepth = 3000): RepoIndexSources {
  return {
    listFiles: async () => (await run(root, ['ls-files', '-z'])).split('\0').filter(Boolean),
    readFile: p => readFile(join(root, p), 'utf8'),
    gitLog: () => run(root, ['log', '--no-merges', '--name-only', '--pretty=format:@@%H', '-n', String(historyDepth)]),
  };
}
