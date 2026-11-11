import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { ContextPack } from '../core/context/pack';
import { panelHtml } from './panelHtml';

/** Everything the panel can show. The extension posts these; the webview only renders. */
export type PanelEvent =
  | { type: 'reset' }
  | { type: 'start'; request: string }
  | { type: 'model'; label: string }
  | { type: 'text'; chunk: string }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'context'; used: number; budget: number; ms: number; dropped: string[]; items: { path: string; line?: number; role: string; granularity: string; tokens: number; reasons: string[] }[] }
  | { type: 'write'; path: string; applied: number; rejected: number }
  | { type: 'retry'; target: string; attempt: number; delayMs: number; reason: string }
  | { type: 'switch'; from: string; to: string; reason: string }
  | { type: 'end'; status: 'done' | 'cancelled' | 'error'; message?: string; changed: string[] }
  | { type: 'undone'; message: string };

export interface PanelActions {
  run(request: string): void;
  stop(): void;
  undo(): void;
  open(path: string, line?: number): void;
}

export const contextEvent = (p: ContextPack): PanelEvent => ({
  type: 'context',
  used: p.used,
  budget: p.budget,
  ms: p.ms,
  dropped: p.dropped.map(d => d.path),
  items: p.items.map(i => ({ path: i.path, line: i.ranges[0]?.[0], role: i.role, granularity: i.granularity, tokens: i.tokens, reasons: i.reasons })),
});

/** One-line description of a tool call for the timeline. */
export function toolSummary(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (name === 'read_file') return `${a.path}${a.start_line ? `:${a.start_line}-${a.end_line ?? ''}` : ''}`;
  if (name === 'search_code') return `/${a.pattern}/${a.glob ? ` in ${a.glob}` : ''}`;
  if (name === 'propose_edit') return `${a.path} (${Array.isArray(a.edits) ? a.edits.length : 0} edit${Array.isArray(a.edits) && a.edits.length === 1 ? '' : 's'}), waiting for your review`;
  if (name === 'create_file') return `${a.path}, waiting for your review`;
  if (name === 'context_pack') return 'ranking files for this request';
  if (name === 'find_symbol') return String(a.name ?? '');
  if (name === 'run_command') return String(a.command ?? '');
  return String(a.path ?? '');
}

/** Sidebar view. Keeps the event log so the view can be closed and reopened mid-run. */
export class KeelPanel implements vscode.WebviewViewProvider {
  static readonly viewId = 'keel.panel';
  private view?: vscode.WebviewView;
  private log: PanelEvent[] = [];

  constructor(private readonly actions: PanelActions) {}

  post(e: PanelEvent): void {
    if (e.type === 'start') this.log = this.log.slice(-400);
    // Coalesce streamed text so a replay is cheap.
    const last = this.log[this.log.length - 1];
    if (e.type === 'text' && last?.type === 'text') last.chunk += e.chunk;
    else this.log.push({ ...e });
    void this.view?.webview.postMessage(e);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = panelHtml(randomBytes(16).toString('base64'), view.webview.cspSource);
    view.webview.onDidReceiveMessage((m: { cmd: string; text?: string; path?: string; line?: number }) => {
      if (m.cmd === 'ready') {
        void view.webview.postMessage({ type: 'reset' });
        for (const e of this.log) void view.webview.postMessage(e);
      } else if (m.cmd === 'run' && m.text) this.actions.run(m.text);
      else if (m.cmd === 'stop') this.actions.stop();
      else if (m.cmd === 'undo') this.actions.undo();
      else if (m.cmd === 'open' && m.path) this.actions.open(m.path, m.line);
    });
    view.onDidDispose(() => (this.view = undefined));
  }
}
