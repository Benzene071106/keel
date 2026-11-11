import type { ApprovalAnswer } from '../trueforge/turnRunner';

export type CommandClass = 'safe' | 'ask' | 'blocked';

/** Shell syntax that lets one "safe" command smuggle in another. */
const CHAINING = /[;&|`<>\n]|\$\(/;

/** Read-only or test-running commands that may run without asking. */
const SAFE: RegExp[] = [
  /^(python3?|py)\s+-m\s+pytest(\s|$)/,
  /^pytest(\s|$)/,
  /^(python3?|py)\s+-m\s+flask\s+(--help|--version|routes|config)(\s|$)/,
  /^flask\s+(--app\s+\S+\s+)?(--help|--version|routes|config)(\s|$)/,
  /^git\s+(status|diff|log|show)(\s|$)/,
  /^(npm|pnpm|yarn)\s+(test|run\s+(test|lint|typecheck|build))(\s|$)/,
  /^(npx\s+)?(tsc|vitest|eslint|ruff|mypy|tox)(\s|$)/,
  /^(ls|dir|pwd|cat|type|head|tail|wc|rg|grep|find|which|where)(\s|$)/,
];

/** Never run, even if the user would click through. */
const BLOCKED: [RegExp, string][] = [
  [/(^|\s)(sudo|doas|runas)(\s|$)/, 'privilege escalation'],
  [/(^|\s)rm\s+(-\w*[rf]\w*\s+)+/, 'recursive or forced delete'],
  [/(^|\s)(rmdir|del|rd|format|mkfs|dd|shutdown|reboot)(\s|$)/i, 'destructive system command'],
  [/(^|\s)git\s+(push|reset\s+--hard|clean|checkout\s+--|restore)(\s|$)/, 'git command that discards or publishes work'],
  [/(curl|wget|iwr|invoke-webrequest)[^|]*\|\s*(sh|bash|zsh|python|node|iex)/i, 'piping a download into an interpreter'],
  [/(^|\s)(npm|pnpm|yarn)\s+publish(\s|$)/, 'publishing a package'],
  [/\.ssh|\.aws|\.env(\s|$|\/)|id_rsa|credentials/i, 'touching credentials'],
];

export function classifyCommand(command: string): { class: CommandClass; reason?: string } {
  const cmd = command.trim();
  if (!cmd) return { class: 'blocked', reason: 'empty command' };
  for (const [re, reason] of BLOCKED) if (re.test(cmd)) return { class: 'blocked', reason };
  if (!CHAINING.test(cmd) && SAFE.some(re => re.test(cmd))) return { class: 'safe' };
  return { class: 'ask' };
}

/** CommandPolicy.autoDecide: allow the allowlist, refuse the blocklist, leave the rest to the user. */
export function autoDecideCommand(command: string): ApprovalAnswer | undefined {
  const c = classifyCommand(command);
  if (c.class === 'safe') return { status: 'allow' };
  if (c.class === 'blocked') return { status: 'deny', reason: `Keel does not run this kind of command (${c.reason}). Ask the user to run it themselves if it is needed.` };
  return undefined;
}
