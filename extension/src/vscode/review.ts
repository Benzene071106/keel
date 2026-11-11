import * as vscode from 'vscode';
import type { Proposal, ReviewDecision } from '../core/review/gate';
import type { Reviewer } from '../core/review/ledger';
import { buildUnifiedView, type UnifiedView } from '../core/review/unified';

const SCHEME = 'keel-review';

interface OpenReview {
  proposal: Proposal;
  view: UnifiedView;
  accepted: Set<number>;
  uri: vscode.Uri;
  done: (d: ReviewDecision) => void;
}

/**
 * Per-hunk review inside the editor.
 * Each proposal opens as a read-only "review document" that shows every hunk's removed lines (red)
 * followed by its added lines (green), with CodeLens buttons to accept or reject each hunk.
 * Nothing touches the real file until the user presses "Done"; the ledger then lets TrueForge run
 * the tool, which writes only the accepted hunks.
 */
export class EditorReviewer implements Reviewer, vscode.TextDocumentContentProvider, vscode.CodeLensProvider, vscode.Disposable {
  private reviews = new Map<string, OpenReview>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  private readonly removedAccepted = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
    textDecoration: 'line-through',
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly addedAccepted = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly rejected = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    opacity: '0.45',
    textDecoration: 'line-through',
  });

  constructor() {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, this),
      vscode.languages.registerCodeLensProvider({ scheme: SCHEME }, this),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorateAll()),
      vscode.commands.registerCommand('keel.review.toggle', (key: string, hunk: number, accept: boolean) => this.toggle(key, hunk, accept)),
      vscode.commands.registerCommand('keel.review.all', (key: string, accept: boolean) => this.setAll(key, accept)),
      vscode.commands.registerCommand('keel.review.done', (arg?: unknown) => this.finish(keyOf(arg) ?? this.activeKey())),
      vscode.commands.registerCommand('keel.review.rejectFile', (arg?: unknown) => {
        const key = keyOf(arg) ?? this.activeKey();
        if (key) this.setAll(key, false);
        this.finish(key);
      }),
      vscode.commands.registerCommand('keel.review.sideBySide', (key: string) => this.sideBySide(key)),
      this.status,
    );
  }

  dispose(): void {
    this.cancelAll();
    for (const d of this.disposables) d.dispose();
    this.removedAccepted.dispose();
    this.addedAccepted.dispose();
    this.rejected.dispose();
  }

  /** Reviewer: review the proposals of one approval pause, one file after another. */
  async review(proposals: Proposal[]): Promise<ReviewDecision[]> {
    const decisions: ReviewDecision[] = [];
    for (let i = 0; i < proposals.length; i++) {
      decisions.push(await this.reviewOne(proposals[i], i + 1, proposals.length));
    }
    this.status.hide();
    return decisions;
  }

  /** Stop: every open review resolves as fully rejected. */
  cancelAll(): void {
    for (const r of [...this.reviews.values()]) this.close(r, { accepted: [], note: 'cancelled' });
  }

  private reviewOne(proposal: Proposal, n: number, total: number): Promise<ReviewDecision> {
    return new Promise(resolve => {
      const view = buildUnifiedView(proposal.oldText, proposal.hunks);
      // The path is only the tab label; the query carries the proposal key.
      const uri = vscode.Uri.from({ scheme: SCHEME, path: `/Review: ${proposal.path.split('/').pop()}`, query: proposal.key });
      const r: OpenReview = { proposal, view, accepted: new Set(proposal.hunks.map(h => h.index)), uri, done: resolve };
      this.reviews.set(proposal.key, r);
      this.status.text = `$(diff) Keel review ${n}/${total}: ${proposal.path}  $(check) Apply`;
      this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.status.command = { command: 'keel.review.done', title: 'Done', arguments: [proposal.key] };
      this.status.show();
      void (async () => {
        const doc = await vscode.workspace.openTextDocument(uri);
        const lang = await languageFor(proposal.path);
        if (lang) await vscode.languages.setTextDocumentLanguage(doc, lang);
        const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
        const first = view.hunks[0];
        if (first) editor.revealRange(new vscode.Range(first.removed[0], 0, first.added[1], 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        this.decorateAll();
        // The review is easy to miss as "just a file": say so, with the two whole-file answers.
        const hunks = proposal.hunks.length;
        const pick = await vscode.window.showInformationMessage(
          `Keel proposes ${hunks} change${hunks === 1 ? '' : 's'} to ${proposal.path}. Accept or reject each one in the editor, then Apply.`,
          'Apply all',
          'Reject all',
        );
        if (!this.reviews.has(proposal.key)) return;
        if (pick === 'Apply all') {
          this.setAll(proposal.key, true);
          this.finish(proposal.key);
        } else if (pick === 'Reject all') {
          this.setAll(proposal.key, false);
          this.finish(proposal.key);
        }
      })();
    });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.reviews.get(uri.query)?.view.text ?? '';
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const r = this.reviews.get(doc.uri.query);
    if (!r) return [];
    const top = new vscode.Range(0, 0, 0, 0);
    const lenses: vscode.CodeLens[] = [
      new vscode.CodeLens(top, { title: `$(check) Apply ${r.accepted.size} of ${r.proposal.hunks.length} hunk${r.proposal.hunks.length === 1 ? '' : 's'} and continue`, command: 'keel.review.done', arguments: [r.proposal.key] }),
      new vscode.CodeLens(top, { title: 'Accept all', command: 'keel.review.all', arguments: [r.proposal.key, true] }),
      new vscode.CodeLens(top, { title: 'Reject all', command: 'keel.review.all', arguments: [r.proposal.key, false] }),
      new vscode.CodeLens(top, { title: 'Side-by-side diff', command: 'keel.review.sideBySide', arguments: [r.proposal.key] }),
    ];
    for (const h of r.view.hunks) {
      const line = Math.max(0, h.removed[0]);
      const range = new vscode.Range(line, 0, line, 0);
      const on = r.accepted.has(h.index);
      lenses.push(
        new vscode.CodeLens(range, { title: `Hunk ${h.index + 1}: ${on ? '$(check) accepted' : '$(x) rejected'}`, command: '' }),
        new vscode.CodeLens(range, { title: on ? 'Reject' : 'Accept', command: 'keel.review.toggle', arguments: [r.proposal.key, h.index, !on] }),
      );
    }
    return lenses;
  }

  private toggle(key: string, hunk: number, accept: boolean) {
    const r = this.reviews.get(key);
    if (!r) return;
    if (accept) r.accepted.add(hunk);
    else r.accepted.delete(hunk);
    this.refresh();
  }

  private setAll(key: string, accept: boolean) {
    const r = this.reviews.get(key);
    if (!r) return;
    r.accepted = new Set(accept ? r.proposal.hunks.map(h => h.index) : []);
    this.refresh();
  }

  private activeKey(): string | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === SCHEME) return uri.query;
    return [...this.reviews.keys()][0];
  }

  private finish(key: string | undefined) {
    const r = key ? this.reviews.get(key) : undefined;
    if (r) this.close(r, { accepted: [...r.accepted].sort((a, b) => a - b) });
  }

  private close(r: OpenReview, d: ReviewDecision) {
    this.reviews.delete(r.proposal.key);
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as { uri?: vscode.Uri; modified?: vscode.Uri } | undefined;
        const u = input?.uri ?? input?.modified;
        if (u && u.scheme.startsWith('keel-') && u.query === r.proposal.key) void vscode.window.tabGroups.close(tab);
      }
    }
    r.done(d);
  }

  private async sideBySide(key: string) {
    const r = this.reviews.get(key);
    if (!r) return;
    const left = await vscode.workspace.openTextDocument({ content: r.proposal.oldText });
    const right = await vscode.workspace.openTextDocument({ content: r.proposal.newText });
    await vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, `${r.proposal.path} (proposed, all hunks)`);
  }

  private refresh() {
    this.lensEmitter.fire();
    this.decorateAll();
  }

  private decorateAll() {
    for (const editor of vscode.window.visibleTextEditors) {
      const r = editor.document.uri.scheme === SCHEME ? this.reviews.get(editor.document.uri.query) : undefined;
      if (!r) continue;
      const removedOn: vscode.Range[] = [];
      const addedOn: vscode.Range[] = [];
      const off: vscode.Range[] = [];
      for (const h of r.view.hunks) {
        const rem = lines(h.removed);
        const add = lines(h.added);
        if (r.accepted.has(h.index)) {
          removedOn.push(...rem);
          addedOn.push(...add);
        } else {
          off.push(...add);
        }
      }
      editor.setDecorations(this.removedAccepted, removedOn);
      editor.setDecorations(this.addedAccepted, addedOn);
      editor.setDecorations(this.rejected, off);
    }
  }
}

function lines([start, end]: [number, number]): vscode.Range[] {
  const out: vscode.Range[] = [];
  for (let l = start; l < end; l++) out.push(new vscode.Range(l, 0, l, 0));
  return out;
}

async function languageFor(path: string): Promise<string | undefined> {
  const ext = path.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = { py: 'python', ts: 'typescript', js: 'javascript', rst: 'restructuredtext', md: 'markdown', json: 'json', toml: 'toml', yml: 'yaml', yaml: 'yaml' };
  const lang = ext ? map[ext] : undefined;
  if (!lang) return undefined;
  const known = await vscode.languages.getLanguages();
  return known.includes(lang) ? lang : undefined;
}

/** Commands arrive with a proposal key (CodeLens, status bar) or with the tab's URI (editor title buttons). */
function keyOf(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  const q = (arg as { query?: unknown } | undefined)?.query;
  return typeof q === 'string' && q ? q : undefined;
}
