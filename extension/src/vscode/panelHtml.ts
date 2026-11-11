/** The agent panel's document. Plain DOM, themed with VS Code's CSS variables. */
export function panelHtml(nonce: string, cspSource: string): string {
  return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">
  body { padding: 0; margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  .wrap { display: flex; flex-direction: column; height: 100vh; }
  .bar { display: flex; gap: 6px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
  .pill { font-size: 11px; padding: 1px 7px; border-radius: 9px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pill.warn { background: var(--vscode-statusBarItem-warningBackground, #b58900); color: var(--vscode-statusBarItem-warningForeground, #fff); }
  .grow { flex: 1; }
  #feed { flex: 1; overflow-y: auto; padding: 8px 10px; }
  .item { margin: 0 0 8px; }
  .req { font-weight: 600; padding: 6px 8px; border-radius: 4px; background: var(--vscode-editor-inactiveSelectionBackground); }
  .say { white-space: pre-wrap; line-height: 1.45; }
  .tool { font-family: var(--vscode-editor-font-family); font-size: 12px; opacity: .85; overflow-wrap: anywhere; }
  .tool b { font-weight: 600; }
  .note { font-size: 12px; padding: 4px 8px; border-left: 3px solid var(--vscode-editorWarning-foreground); background: var(--vscode-inputValidation-warningBackground, transparent); }
  .note.err { border-left-color: var(--vscode-editorError-foreground); background: var(--vscode-inputValidation-errorBackground, transparent); }
  .note.ok { border-left-color: var(--vscode-testing-iconPassed, #3fb950); background: transparent; }
  details { border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
  summary { cursor: pointer; padding: 5px 8px; font-weight: 600; }
  .meter { height: 4px; background: var(--vscode-editorWidget-border, #444); border-radius: 2px; margin: 0 8px 6px; }
  .meter > div { height: 100%; border-radius: 2px; background: var(--vscode-progressBar-background); }
  .file { padding: 4px 8px; border-top: 1px solid var(--vscode-panel-border); }
  .file a, .chg a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  .file a:hover, .chg a:hover { text-decoration: underline; }
  .tag { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; margin-left: 6px; }
  .why { font-size: 12px; opacity: .8; margin: 2px 0 0; padding-left: 14px; }
  .why li { margin: 0; }
  .left { font-size: 12px; opacity: .7; padding: 4px 8px; border-top: 1px solid var(--vscode-panel-border); }
  .chg { font-size: 12px; }
  .chg .rej { color: var(--vscode-editorWarning-foreground); }
  form { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--vscode-panel-border); }
  textarea { flex: 1; min-width: 0; overflow: hidden; resize: none; min-height: 34px; max-height: 120px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 6px; }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  button { font: inherit; border: 0; border-radius: 3px; padding: 4px 10px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.sec { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:disabled { opacity: .5; cursor: default; }
  .empty { opacity: .7; padding: 14px 4px; line-height: 1.5; }
</style>
</head>
<body>
<div class="wrap">
  <div class="bar">
    <span id="model" class="pill" title="TrueForge agent serving this run">idle</span>
    <span class="grow"></span>
    <button id="undo" class="sec" title="Revert every file the last run changed" disabled>Undo run</button>
    <button id="stop" class="sec" disabled>Stop</button>
  </div>
  <div id="feed"><div class="empty" id="empty">Ask Keel to change something. It first shows which files it picked and why, then proposes edits you accept or reject hunk by hunk.<br><br>Mention files or symbols with @, e.g. <code>@src/flask/cli.py</code>.</div></div>
  <form id="form">
    <textarea id="input" rows="1" placeholder="Ask Keel to change something" title="Enter to send, Shift+Enter for a new line"></textarea>
    <button id="send" type="submit">Run</button>
  </form>
</div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const feed = $('feed');
  let say = null; // current streaming text block
  let running = false;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function add(node) {
    const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
    const empty = $('empty');
    if (empty) empty.remove();
    node.classList.add('item');
    feed.appendChild(node);
    if (stick) feed.scrollTop = feed.scrollHeight;
    return node;
  }
  function fileLink(path, line) {
    const a = el('a', '', path);
    a.addEventListener('click', () => vscode.postMessage({ cmd: 'open', path, line }));
    return a;
  }
  function setRunning(on) {
    running = on;
    $('stop').disabled = !on;
    $('send').disabled = on;
  }

  const handlers = {
    reset() { feed.textContent = ''; say = null; },
    start(e) { say = null; add(el('div', 'req', e.request)); setRunning(true); $('undo').disabled = true; $('model').className = 'pill'; },
    model(e) { $('model').textContent = e.label; },
    text(e) {
      if (!say) say = add(el('div', 'say', ''));
      say.textContent += e.chunk;
      feed.scrollTop = feed.scrollHeight;
    },
    tool(e) {
      say = null;
      const d = el('div', 'tool');
      d.appendChild(el('b', '', e.name));
      d.appendChild(document.createTextNode(' ' + e.summary));
      d.title = e.summary;
      add(d);
    },
    context(e) {
      say = null;
      const d = el('details');
      d.open = true;
      d.appendChild(el('summary', '', 'Context: ' + e.items.length + ' files, ' + e.used + ' of ' + e.budget + ' tokens (' + e.ms + ' ms)'));
      const m = el('div', 'meter');
      const fill = el('div');
      fill.style.width = Math.min(100, Math.round((e.used / e.budget) * 100)) + '%';
      m.appendChild(fill);
      d.appendChild(m);
      for (const it of e.items) {
        const f = el('div', 'file');
        f.appendChild(fileLink(it.path, it.line));
        f.appendChild(el('span', 'tag', it.role + ' · ' + it.granularity + ' · ' + it.tokens + ' tok'));
        const ul = el('ul', 'why');
        for (const r of it.reasons) ul.appendChild(el('li', '', r));
        f.appendChild(ul);
        d.appendChild(f);
      }
      if (e.dropped.length) d.appendChild(el('div', 'left', 'Left out: ' + e.dropped.join(', ')));
      add(d);
    },
    toolError(e) { say = null; add(el('div', 'note err', e.message)); },
    write(e) {
      say = null;
      const d = el('div', 'chg');
      d.appendChild(document.createTextNode('Changed '));
      d.appendChild(fileLink(e.path));
      d.appendChild(document.createTextNode(': ' + e.applied + ' hunk' + (e.applied === 1 ? '' : 's') + ' applied'));
      if (e.rejected) d.appendChild(el('span', 'rej', ', ' + e.rejected + ' rejected by you'));
      add(d);
    },
    retry(e) { say = null; const secs = (e.delayMs / 1000).toFixed(1) + ' s'; add(el('div', 'note', e.hinted ? (e.target + ' is rate-limited. Waiting ' + secs + ', as the provider asked, then retry ' + e.attempt + '. Stop cancels the wait.') : (e.target + ' had a temporary error. Retry ' + e.attempt + ' in ' + secs + '. ' + e.reason))); },
    switch(e) { say = null; $('model').className = 'pill warn'; add(el('div', 'note', 'Model failed: ' + e.reason + ' Switched from ' + e.from + ' to ' + e.to + '.')); },
    end(e) {
      say = null;
      setRunning(false);
      $('undo').disabled = !e.changed.length;
      const cls = e.status === 'done' ? 'note ok' : e.status === 'error' ? 'note err' : 'note';
      const head = e.status === 'done' ? 'Done.' : e.status === 'cancelled' ? 'Stopped. Nothing is half-applied.' : 'Failed: ' + e.message;
      const tail = e.changed.length ? ' Files changed: ' + e.changed.join(', ') + '.' : ' No files changed.';
      add(el('div', cls, head + tail));
    },
    undone(e) { $('undo').disabled = true; add(el('div', 'note ok', e.message)); },
  };

  window.addEventListener('message', ev => {
    const e = ev.data;
    if (handlers[e.type]) handlers[e.type](e);
  });

  const input = $('input');
  function send() {
    const text = input.value.trim();
    if (!text || running) return;
    vscode.postMessage({ cmd: 'run', text });
    input.value = '';
    input.style.height = '';
  }
  $('form').addEventListener('submit', ev => { ev.preventDefault(); send(); });
  input.addEventListener('keydown', ev => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); } });
  input.addEventListener('input', () => { input.style.height = ''; input.style.height = Math.min(120, input.scrollHeight) + 'px'; input.style.overflowY = input.scrollHeight > 120 ? 'auto' : 'hidden'; });
  $('stop').addEventListener('click', () => vscode.postMessage({ cmd: 'stop' }));
  $('undo').addEventListener('click', () => vscode.postMessage({ cmd: 'undo' }));
  vscode.postMessage({ cmd: 'ready' });
})();
</script>
</body>
</html>`;
}
