// Claude Edit Gutter -- renders Claude Code edits inside the already-open
// editor instead of opening diff tabs.
//
// Self-installing: on activation the extension writes its own PostToolUse
// hook (hooks/show-edit-diff.py) into ~/.claude/hooks/ and registers it in
// ~/.claude/settings.json, so a fresh install needs no manual setup. Both
// steps are idempotent and back up any file they change (see
// ensureClaudeIntegration below).
//
// Data source: that PostToolUse hook (~/.claude/hooks/show-edit-diff.py)
// stashes each edit's pre-change content under
//   /tmp/claude-edit-diffs-<uid>/<sha1(path)[:8]>/<basename>
// with a ".path" sidecar holding the real file path.
//
// Review model (Cursor-style): every Claude edit leaves a persistent green
// block in the buffer. The full old-vs-new diff (removed red, added green)
// is in the block's hover, along with Approve/Reject links. True phantom
// lines above the block (Cursor's red-above-green) are not possible in
// stock VSCode (view zones are private API); ghost text and comment-thread
// widgets were both tried and rejected by the user - do not reintroduce.
// Blocks shift with subsequent edits, overlapping blocks merge, and
// nothing removes them except Approve or Reject (Reject restores the old
// text): hover links, CodeLens buttons (when editor.codeLens is on), or
// the "Claude edits: N" status bar menu.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const STASH = '/tmp/claude-edit-diffs-' + process.getuid();
const SCHEME = 'claude-before';
const MAX_DIFF_LINES = 30;

// Self-install targets.
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const HOOK_DEST = path.join(CLAUDE_DIR, 'hooks', 'show-edit-diff.py');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const HOOK_CMD = 'python3 ~/.claude/hooks/show-edit-diff.py';

function tagFor(fp) {
  return crypto.createHash('sha1').update(fp).digest('hex').slice(0, 8);
}

function stashFor(fp) {
  return path.join(STASH, tagFor(fp), path.basename(fp));
}

function realpath(fp) {
  try { return fs.realpathSync(fp); } catch (e) { return fp; }
}

function inGitRepo(fp) {
  let d = path.dirname(fp);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return true;
    const parent = path.dirname(d);
    if (parent === d) return false;
    d = parent;
  }
}

// --- Self-install: hook script + settings.json wiring --------------------
// Make the extension work end-to-end with zero manual steps. Runs on every
// activation; every branch is idempotent and backs up what it overwrites.

function backup(fp) {
  try { fs.copyFileSync(fp, fp + '.claude-edit-gutter.bak'); } catch (e) { /* ignore */ }
}

// Copy the bundled hook into ~/.claude/hooks/ when missing or out of date.
function installHookScript(context, logLine) {
  const src = path.join(context.extensionPath, 'hooks', 'show-edit-diff.py');
  let want;
  try { want = fs.readFileSync(src, 'utf8'); }
  catch (e) { logLine('bundled hook missing: ' + e.message); return; }
  let have = null;
  try { have = fs.readFileSync(HOOK_DEST, 'utf8'); } catch (e) { /* not installed yet */ }
  if (have === want) return;
  try {
    fs.mkdirSync(path.dirname(HOOK_DEST), { recursive: true });
    if (have !== null) backup(HOOK_DEST);
    fs.writeFileSync(HOOK_DEST, want);
    fs.chmodSync(HOOK_DEST, 0o755);
    logLine(have === null ? 'installed hook: ' + HOOK_DEST
                          : 'updated hook: ' + HOOK_DEST + ' (.bak kept)');
  } catch (e) { logLine('hook write failed: ' + e.message); }
}

// Ensure ~/.claude/settings.json registers our PostToolUse hook. Merges into
// existing settings; never clobbers unrelated keys or an existing entry.
function installSettingsHook(logLine) {
  let settings = {};
  let raw = null;
  try {
    raw = fs.readFileSync(SETTINGS, 'utf8');
    settings = JSON.parse(raw);
  } catch (e) {
    if (raw !== null) {
      // File exists but is unparseable -- leave it alone rather than lose it.
      logLine('settings.json is not valid JSON; skipping (edit hooks manually)');
      return;
    }
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return;

  const hooks = settings.hooks || (settings.hooks = {});
  const post = Array.isArray(hooks.PostToolUse)
    ? hooks.PostToolUse : (hooks.PostToolUse = []);
  const already = post.some((g) =>
    g && Array.isArray(g.hooks) && g.hooks.some((h) =>
      h && typeof h.command === 'string' && h.command.indexOf('show-edit-diff.py') !== -1));
  if (already) return;

  post.push({
    matcher: 'Edit|Write',
    hooks: [{
      type: 'command',
      command: HOOK_CMD,
      async: true,
      timeout: 15,
      statusMessage: 'Rendering Claude edit in the open editor'
    }]
  });

  try {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    if (raw !== null) backup(SETTINGS);
    fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
    logLine('registered PostToolUse Edit|Write hook in ' + SETTINGS +
            (raw !== null ? ' (.bak kept)' : ''));
  } catch (e) { logLine('settings write failed: ' + e.message); }
}

function ensureClaudeIntegration(context) {
  const out = vscode.window.createOutputChannel('Claude Edit Gutter');
  context.subscriptions.push(out);
  const logLine = (m) => { try { out.appendLine(m); } catch (e) { /* ignore */ } };
  try {
    installHookScript(context, logLine);
    installSettingsHook(logLine);
  } catch (e) { logLine('self-install error: ' + (e && e.message)); }
}

// Display diff for a block: capped, hover-friendly.
function renderDiff(removed, added) {
  const dl = [];
  removed.slice(0, MAX_DIFF_LINES).forEach((l) => dl.push('- ' + l));
  if (removed.length > MAX_DIFF_LINES) {
    dl.push('- ... (' + (removed.length - MAX_DIFF_LINES) + ' more removed lines)');
  }
  added.slice(0, MAX_DIFF_LINES).forEach((l) => dl.push('+ ' + l));
  if (added.length > MAX_DIFF_LINES) {
    dl.push('+ ... (' + (added.length - MAX_DIFF_LINES) + ' more added lines)');
  }
  return dl.join('\n') || '(no line changes)';
}

// Original text for a merged block: the pre-edit lines of the union region,
// with the older block's span substituted by ITS original text.
function composeRemoved(a, s, oldEnd, blk) {
  const uS = Math.max(0, Math.min(blk.range.start.line, s));
  const uE = Math.min(a.length - 1, Math.max(blk.range.end.line, oldEnd));
  const seg = [];
  for (let i = uS; i <= uE; i++) {
    if (i === blk.range.start.line) {
      for (const l of blk.removed) seg.push(l);
      if (blk.addedCount === 0 && a[i] !== undefined) seg.push(a[i]);
      i = blk.range.end.line;
    } else if (a[i] !== undefined) {
      seg.push(a[i]);
    }
  }
  return seg;
}

function activate(context) {
  try { fs.mkdirSync(STASH, { recursive: true }); } catch (e) { /* ignore */ }

  // Wire up the Claude Code hook so this extension works out of the box.
  ensureClaudeIntegration(context);

  // --- Quick-diff provider (gutter marks for non-git files) --------------

  const changeEmitter = new vscode.EventEmitter();
  context.subscriptions.push(changeEmitter);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      onDidChange: changeEmitter.event,
      provideTextDocumentContent(uri) {
        const real = uri.path;
        try { return fs.readFileSync(stashFor(real), 'utf8'); } catch (e) { /* no stash yet */ }
        try { return fs.readFileSync(real, 'utf8'); } catch (e) { return ''; }
      }
    })
  );

  const sc = vscode.scm.createSourceControl(
    'claude-edits', 'Claude Edits', vscode.Uri.file(os.homedir()));
  sc.quickDiffProvider = {
    provideOriginalResource(uri) {
      if (uri.scheme !== 'file') return null;
      const real = realpath(uri.fsPath);
      if (real.startsWith('/tmp/')) return null;
      if (inGitRepo(real)) return null; // git's own gutter handles those
      return vscode.Uri.from({ scheme: SCHEME, path: real });
    }
  };
  context.subscriptions.push(sc);

  // --- Persistent highlight blocks ---------------------------------------

  const deco = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(63, 185, 80, 0.22)',
    borderColor: 'rgba(63, 185, 80, 0.95)',
    borderStyle: 'solid',
    borderWidth: '0 0 0 3px',
    overviewRulerColor: 'rgba(63, 185, 80, 0.95)',
    overviewRulerLane: vscode.OverviewRulerLane.Full
  });
  context.subscriptions.push(deco);

  // realpath -> [{range, diff, removed, addedCount}]
  const blocks = new Map();
  // fs.watch fires several events per stash write; process each edit once.
  const lastSeen = new Map(); // realpath -> stash fingerprint
  // Tracking toggle: user-controlled via the status bar menu, persisted.
  let enabled = context.globalState.get('claudeEditGutter.enabled', true);
  const lensEmitter = new vscode.EventEmitter();
  context.subscriptions.push(lensEmitter);

  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'claudeEditGutter.showMenu';
  context.subscriptions.push(statusItem);

  function applyBlocks(ed, real) {
    const opts = (blocks.get(real) || []).map((blk, i) => {
      const md = new vscode.MarkdownString();
      md.isTrusted = true;
      md.appendMarkdown(
        '**Claude edit** -- ' +
        '[Approve](command:claudeEditGutter.approveBlock?' +
        encodeURIComponent(JSON.stringify([real, i])) + ') | ' +
        '[Reject (restore old text)](command:claudeEditGutter.rejectBlock?' +
        encodeURIComponent(JSON.stringify([real, i])) + ') | ' +
        '[Approve all in file](command:claudeEditGutter.approveFile?' +
        encodeURIComponent(JSON.stringify([real])) + ')\n\n');
      md.appendCodeblock(blk.diff, 'diff');
      return { range: blk.range, hoverMessage: md };
    });
    ed.setDecorations(deco, opts);
  }

  function refreshUi(real) {
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.scheme !== 'file') continue;
      if (realpath(ed.document.uri.fsPath) === real) applyBlocks(ed, real);
    }
    lensEmitter.fire();
    let total = 0;
    for (const list of blocks.values()) total += list.length;
    if (!enabled) {
      statusItem.text = '$(circle-slash) Claude edits: off';
      statusItem.tooltip = 'Claude edit tracking is disabled. Click to re-enable.';
      statusItem.show();
    } else if (total === 0) {
      statusItem.hide();
    } else {
      statusItem.text = '$(sparkle) Claude edits: ' + total;
      statusItem.tooltip = 'Unreviewed Claude edits. Click to review.';
      statusItem.show();
    }
  }

  function setBlocks(real, list) {
    if (!list || list.length === 0) blocks.delete(real);
    else blocks.set(real, list);
    refreshUi(real);
  }

  function flash(real) {
    if (!enabled) return;
    // Small delay so the auto-reloaded buffer reflects the change first.
    setTimeout(() => {
      let st;
      try { st = fs.statSync(stashFor(real)); } catch (e) { return; }
      const fp = st.mtimeMs + ':' + st.size;
      if (lastSeen.get(real) === fp) return; // duplicate watcher event
      lastSeen.set(real, fp);
      {
        let before;
        try { before = fs.readFileSync(stashFor(real), 'utf8'); } catch (e) { return; }
        // Prefer the open editor's buffer; fall back to disk so edits to
        // files not open in any editor are tracked too.
        const ed = vscode.window.visibleTextEditors.find((x) =>
          x.document.uri.scheme === 'file' &&
          realpath(x.document.uri.fsPath) === real);
        let afterText;
        if (ed) {
          afterText = ed.document.getText();
        } else {
          try { afterText = fs.readFileSync(real, 'utf8'); } catch (e) { return; }
        }
        const a = before.split('\n');
        const b = afterText.split('\n');
        // Trim common prefix/suffix; what remains is the changed block.
        let s = 0;
        while (s < a.length && s < b.length && a[s] === b[s]) s++;
        let e = 0;
        while (e < a.length - s && e < b.length - s &&
               a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
        const lastLine = Math.max(0, b.length - 1);
        const startLine = Math.min(s, lastLine);
        const endLine = Math.min(Math.max(s, b.length - e - 1), lastLine);
        const removed = a.slice(s, a.length - e);
        const added = b.slice(s, b.length - e);
        // Shift older blocks that sit below this change so they keep
        // pointing at the same text; never remove them.
        const oldEnd = a.length - e - 1;
        const delta = b.length - a.length;
        const shifted = (blocks.get(real) || []).map((blk) =>
          (delta !== 0 && blk.range.start.line > oldEnd)
            ? { range: new vscode.Range(blk.range.start.line + delta, 0,
                                        blk.range.end.line + delta, 0),
                diff: blk.diff, removed: blk.removed, addedCount: blk.addedCount }
            : blk);
        // Merge overlapping regions so each carries exactly one Approve;
        // the merged block keeps the ORIGINAL old text so Reject restores
        // the state before all constituent edits.
        let cur = {
          range: new vscode.Range(startLine, 0, endLine, 0),
          diff: renderDiff(removed, added),
          removed: removed,
          addedCount: added.length
        };
        const list = [];
        for (const blk of shifted) {
          if (blk.range.end.line >= cur.range.start.line &&
              cur.range.end.line >= blk.range.start.line) {
            const uS = Math.min(blk.range.start.line, cur.range.start.line);
            const uE = Math.min(Math.max(blk.range.end.line, cur.range.end.line),
                                lastLine);
            const composed = composeRemoved(a, s, oldEnd, blk);
            const unionAdded = b.slice(uS, uE + 1);
            cur = {
              range: new vscode.Range(uS, 0, uE, 0),
              diff: renderDiff(composed, unionAdded),
              removed: composed,
              addedCount: uE - uS + 1
            };
          } else {
            list.push(blk);
          }
        }
        list.push(cur);
        list.sort((x, y) => x.range.start.line - y.range.start.line);
        blocks.delete(real); // re-insert so the just-edited file sorts last (most recent)
        setBlocks(real, list);
      }
    }, 400);
  }

  // --- Keep blocks positioned as the user types ---------------------------
  // User edits never remove highlights -- they only shift them so they stay
  // attached to the same text. Removal happens only via Approve/Reject.

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors((eds) => {
      for (const ed of eds) {
        if (ed.document.uri.scheme !== 'file') continue;
        const real = realpath(ed.document.uri.fsPath);
        if (blocks.has(real)) applyBlocks(ed, real);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((ev) => {
      // isDirty distinguishes buffer edits (the user typing, or our own
      // Reject) from Claude's on-disk edits (which reload non-dirty).
      if (!ev.document.isDirty || ev.contentChanges.length === 0) return;
      if (ev.document.uri.scheme !== 'file') return;
      const real = realpath(ev.document.uri.fsPath);
      let list = blocks.get(real);
      if (!list || list.length === 0) return;
      for (const ch of ev.contentChanges) {
        const startL = ch.range.start.line;
        const endL = ch.range.end.line;
        const delta = (ch.text.split('\n').length - 1) - (endL - startL);
        list = list.map((blk) => {
          const r = blk.range;
          if (r.end.line < startL || delta === 0) return blk;
          if (r.start.line > endL) {
            return {
              range: new vscode.Range(
                r.start.line + delta, 0, r.end.line + delta, 0),
              diff: blk.diff, removed: blk.removed, addedCount: blk.addedCount
            };
          }
          // typed inside the block: keep it, growing/shrinking with the edit
          return {
            range: new vscode.Range(
              r.start.line, 0, Math.max(r.start.line, r.end.line + delta), 0),
            diff: blk.diff, removed: blk.removed, addedCount: blk.addedCount
          };
        });
      }
      setBlocks(real, list);
    })
  );

  // --- Approve / Reject ----------------------------------------------------

  async function docFor(real) {
    const open = vscode.workspace.textDocuments.find((d) =>
      d.uri.scheme === 'file' && realpath(d.uri.fsPath) === real);
    if (open) return open;
    try { return await vscode.workspace.openTextDocument(real); } catch (e) { return null; }
  }

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
      onDidChangeCodeLenses: lensEmitter.event,
      provideCodeLenses(doc) {
        const real = realpath(doc.uri.fsPath);
        const list = blocks.get(real);
        if (!list || list.length === 0) return [];
        const lenses = [];
        list.forEach((blk, i) => {
          lenses.push(new vscode.CodeLens(blk.range, {
            title: 'Approve Claude edit',
            command: 'claudeEditGutter.approveBlock',
            arguments: [real, i]
          }));
          lenses.push(new vscode.CodeLens(blk.range, {
            title: 'Reject',
            command: 'claudeEditGutter.rejectBlock',
            arguments: [real, i]
          }));
          if (list.length > 1) {
            lenses.push(new vscode.CodeLens(blk.range, {
              title: 'Approve all in file (' + list.length + ')',
              command: 'claudeEditGutter.approveFile',
              arguments: [real]
            }));
          }
        });
        return lenses;
      }
    }),
    vscode.commands.registerCommand('claudeEditGutter.approveBlock', (real, i) => {
      const list = (blocks.get(real) || []).slice();
      list.splice(i, 1);
      setBlocks(real, list);
    }),
    vscode.commands.registerCommand('claudeEditGutter.approveFile', (real) => {
      setBlocks(real, []);
    }),
    vscode.commands.registerCommand('claudeEditGutter.approveAll', () => {
      for (const real of Array.from(blocks.keys())) setBlocks(real, []);
      refreshUi('');
    }),
    vscode.commands.registerCommand('claudeEditGutter.showMenu', async () => {
      const items = [];
      if (!enabled) {
        items.push({ label: '$(play) Enable Claude edit tracking', action: 'enable' });
      } else {
        let total = 0;
        for (const list of blocks.values()) total += list.length;
        items.push({
          label: '$(check-all) Approve all edits (' + total + ')',
          action: 'approveAll'
        });
        items.push({
          label: '$(circle-slash) Disable edit tracking',
          description: 'clears current markings; new edits go unmarked',
          action: 'disable'
        });
        // Newest-edited file first.
        for (const [real, list] of Array.from(blocks.entries()).reverse()) {
          items.push({
            label: real.replace(os.homedir(), '~'),
            kind: vscode.QuickPickItemKind.Separator
          });
          // Filter out duplicate edits to the same file: one entry per file.
          const blk = list[0];
          items.push({
            label: '$(edit) ' + path.basename(real) + ':' + (blk.range.start.line + 1),
            detail: blk.diff.split('\n').slice(0, 2).join('  '),
            action: 'goto', real: real, index: 0
          });
        }
      }
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Claude edits'
      });
      if (!pick) return;
      if (pick.action === 'enable') {
        enabled = true;
        context.globalState.update('claudeEditGutter.enabled', true);
        refreshUi('');
        return;
      }
      if (pick.action === 'disable') {
        enabled = false;
        context.globalState.update('claudeEditGutter.enabled', false);
        for (const real of Array.from(blocks.keys())) setBlocks(real, []);
        refreshUi('');
        return;
      }
      if (pick.action === 'approveAll') {
        vscode.commands.executeCommand('claudeEditGutter.approveAll');
        return;
      }
      const doc = await docFor(pick.real);
      if (!doc) return;
      const ed = await vscode.window.showTextDocument(doc);
      const blk = (blocks.get(pick.real) || [])[pick.index];
      if (blk) {
        ed.selection = new vscode.Selection(blk.range.start, blk.range.start);
        ed.revealRange(blk.range, vscode.TextEditorRevealType.InCenter);
      }
    }),
    vscode.commands.registerCommand('claudeEditGutter.rejectBlock', async (real, i) => {
      const list = (blocks.get(real) || []).slice();
      const blk = list[i];
      if (!blk) return;
      const doc = await docFor(real);
      if (!doc) return;
      const we = new vscode.WorkspaceEdit();
      const maxLine = Math.max(0, doc.lineCount - 1);
      const startLine = Math.min(blk.range.start.line, maxLine);
      if (blk.addedCount > 0) {
        const endLine = Math.min(blk.range.end.line, maxLine);
        if (blk.removed.length > 0) {
          we.replace(doc.uri,
            new vscode.Range(startLine, 0,
              endLine, doc.lineAt(endLine).range.end.character),
            blk.removed.join('\n'));
        } else {
          // Pure insertion by Claude: rejecting deletes the added lines.
          const end = endLine + 1 <= maxLine
            ? new vscode.Position(endLine + 1, 0)
            : doc.lineAt(endLine).range.end;
          we.delete(doc.uri, new vscode.Range(
            new vscode.Position(startLine, 0), end));
        }
      } else {
        // Pure deletion by Claude: rejecting re-inserts the removed lines.
        we.insert(doc.uri, new vscode.Position(startLine, 0),
          blk.removed.join('\n') + '\n');
      }
      // Drop the block first so the text-change handler only shifts others.
      list.splice(i, 1);
      setBlocks(real, list);
      await vscode.workspace.applyEdit(we);
      try { await doc.save(); } catch (e) { /* leave buffer dirty */ }
    })
  );

  // --- Watch the stash dir for updates from the hook ---------------------

  function onStashEvent(fsPath) {
    if (path.basename(fsPath) === '.path') return;
    let real;
    try {
      real = fs.readFileSync(path.join(path.dirname(fsPath), '.path'), 'utf8').trim();
    } catch (e) { return; }
    changeEmitter.fire(vscode.Uri.from({ scheme: SCHEME, path: real }));
    flash(real);
  }

  let watching = false;
  try {
    const w = fs.watch(STASH, { recursive: true }, (evt, name) => {
      if (name) onStashEvent(path.join(STASH, name));
    });
    context.subscriptions.push({ dispose: () => { try { w.close(); } catch (e) { /* ignore */ } } });
    watching = true;
  } catch (e) { /* recursive fs.watch unavailable */ }

  if (!watching) {
    const w = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(STASH), '**/*'));
    w.onDidCreate((u) => onStashEvent(u.fsPath));
    w.onDidChange((u) => onStashEvent(u.fsPath));
    context.subscriptions.push(w);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
