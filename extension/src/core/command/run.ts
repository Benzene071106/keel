import { spawn, type ChildProcess } from 'node:child_process';

export interface CommandResult {
  exitCode: number | null;
  /** Combined stdout+stderr, trimmed to the last MAX_OUTPUT characters. */
  output: string;
  timedOut: boolean;
  killed: boolean;
  ms: number;
}

const MAX_OUTPUT = 12_000;

/** Runs shell commands in the workspace and can kill everything it started (Stop). */
export class CommandRunner {
  private live = new Set<ChildProcess>();
  private stoppers = new Map<ChildProcess, () => void>();

  constructor(private readonly root: string) {}

  run(command: string, opts: { timeoutMs?: number; onOutput?: (chunk: string) => void } = {}): Promise<CommandResult> {
    const t0 = Date.now();
    return new Promise(resolve => {
      const child = spawn(command, { cwd: this.root, shell: true, windowsHide: true, detached: process.platform !== 'win32', env: { ...process.env, PYTHONUNBUFFERED: '1', FORCE_COLOR: '0' } });
      this.live.add(child);
      let output = '';
      let timedOut = false;
      let stopped = false;
      this.stoppers.set(child, () => (stopped = true));
      const onData = (b: Buffer) => {
        const s = b.toString('utf8');
        opts.onOutput?.(s);
        output = (output + s).slice(-MAX_OUTPUT * 2);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      const timer = setTimeout(() => {
        timedOut = true;
        kill(child);
      }, opts.timeoutMs ?? 120_000);
      const finish = (exitCode: number | null) => {
        clearTimeout(timer);
        if (!this.live.delete(child)) return;
        this.stoppers.delete(child);
        const trimmed = output.length > MAX_OUTPUT ? `... (earlier output cut)\n${output.slice(-MAX_OUTPUT)}` : output;
        resolve({ exitCode, output: trimmed, timedOut, killed: stopped && !timedOut, ms: Date.now() - t0 });
      };
      child.on('error', e => {
        output += `\n${e.message}`;
        finish(null);
      });
      child.on('close', code => finish(code));
    });
  }

  killAll(): void {
    for (const c of this.live) {
      this.stoppers.get(c)?.();
      kill(c);
    }
  }
}

/** Kill the shell and everything it started; killing only the shell leaves the real process running. */
function kill(child: ChildProcess) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL'); // detached: the child leads its own process group
  } catch {
    /* already gone */
  }
  child.kill('SIGKILL');
}
