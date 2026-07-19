# Claude Edit Gutter

Renders [Claude Code](https://docs.anthropic.com/en/docs/claude-code) edits
**inside the already-open editor** instead of popping diff tabs:

- **Quick-diff gutter marks** (with inline peek) on files that are *not* in a
  git repo -- git's own gutter already covers tracked files.
- **A persistent green highlight block** on the lines Claude just edited, in
  any file. Hover it (or use the CodeLens buttons / the "Claude edits: N"
  status-bar menu) to see the full old-vs-new diff and to **Approve** or
  **Reject** the change. Reject restores the previous text.

Blocks shift as you keep typing and merge when they overlap; nothing clears a
block except Approve or Reject.

## Zero-setup install

On first activation the extension wires itself into Claude Code -- **no manual
hook editing required**:

1. It copies its `PostToolUse` hook to `~/.claude/hooks/show-edit-diff.py`.
2. It registers that hook for `Edit|Write` tools in `~/.claude/settings.json`.

Both steps are idempotent and back up any file they change
(`*.claude-edit-gutter.bak`). If `settings.json` already references the hook,
or is not valid JSON, the extension leaves it untouched. Progress is logged to
the **Claude Edit Gutter** output channel (View -> Output).

### How it works

The hook runs after each Claude `Edit`/`Write`, reconstructs the file's
pre-edit content, and stashes it under
`/tmp/claude-edit-diffs-<uid>/<hash>/` with a `.path` sidecar. The extension
watches that directory and diffs the stashed "before" against the current
buffer to draw the gutter marks and highlight block. Temp files (`/tmp/...`)
are ignored.

## Install

```sh
code --install-extension claude-edit-gutter-0.0.1.vsix
```

Then reload the window. That's it -- open a file, let Claude edit it, and the
change shows up inline.

## Manual hook setup (only if you disabled self-install)

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.claude/hooks/show-edit-diff.py",
            "async": true,
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

and copy `hooks/show-edit-diff.py` to `~/.claude/hooks/` (make it executable).
