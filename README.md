# Claude Edit Gutter

Review [Claude Code](https://docs.anthropic.com/en/docs/claude-code) edits
**in your editor** -- gutter marks and a highlighted block on the lines Claude
just changed -- instead of Claude Code popping a separate diff tab for every
edit.

When Claude edits a file, the touched lines get a green highlight block with a
hover that shows the full old-vs-new diff and **Approve** / **Reject**
actions. Reject restores the previous text. Blocks persist until you approve or
reject them, shift as you keep typing, and merge when they overlap.

Edits to files you don't currently have open are tracked too -- the change is
captured from disk, counts toward the `Claude edits: N` status-bar total and
shows in the review menu, and the highlight block appears the moment you open
the file.

## Features

- **In-editor highlight blocks** on the lines Claude just edited, in any file.
- **Hover to review** -- the full diff (removed/added) plus Approve, Reject,
  and "Approve all in file" links, right on the block.
- **CodeLens buttons** (Approve / Reject) above each block when
  `editor.codeLens` is enabled.
- **Quick-diff gutter marks** with inline peek for files that are *not* in a
  git repository (git's own gutter already covers tracked files).
- **Status-bar review menu** -- a `$(sparkle) Claude edits: N` item; click it
  to jump to any pending edit, approve everything, or toggle tracking off. The
  menu lists **one row per file, most-recently-edited file first**.
- **Reject truly reverts** -- restores the pre-edit text (re-inserts deletions,
  removes insertions, or puts back the old lines).
- **No diff tabs, no new windows** -- everything renders in place.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with hooks
  enabled (`~/.claude/settings.json`).
- `python3` on your `PATH` (the hook is a small Python script).
- VS Code `^1.70.0`.

## Install

Grab the `.vsix` from the [latest release](https://github.com/patrickdk77/claude-edit-gutter/releases/latest)
and install it:

```sh
code --install-extension claude-edit-gutter-<version>.vsix
```

Then reload the window. The extension is **self-installing**: on first
activation it wires itself into Claude Code with no manual steps (see below).

## Zero-setup: how it hooks into Claude Code

On activation the extension sets up its own Claude Code integration and backs
up anything it changes (`*.claude-edit-gutter.bak`):

1. It copies its `PostToolUse` hook to `~/.claude/hooks/show-edit-diff.py`.
2. It registers that hook for `Edit|Write` tools in `~/.claude/settings.json`.

If the hook is already registered, or `settings.json` isn't valid JSON, the
extension leaves your settings untouched. Progress is logged to the **Claude
Edit Gutter** output channel (View -> Output).

### The data flow

1. Claude runs an `Edit`/`Write` -> Claude Code fires the `PostToolUse` hook
   (async, non-blocking).
2. The hook reconstructs the file's pre-edit content (from the tool response,
   by reversing the edit, or from `git HEAD`) and stashes it under
   `/tmp/claude-edit-diffs-<uid>/<hash>/` with a `.path` sidecar.
3. The extension watches that directory, diffs the stashed "before" against the
   live buffer, and draws the highlight block / gutter marks.

Files under `/tmp/` are treated as scratch and ignored.

## Usage

1. Let Claude Code edit a file that's open (or that you then open).
2. The changed lines get a green block. Hover it to see the diff and to
   **Approve** (keep the change, clear the marker) or **Reject** (restore the
   old text).
3. Or click the `Claude edits: N` status-bar item to open the review menu:
   pick a file to jump to its most recent edit, **Approve all edits**, or
   **Disable edit tracking**.

Approving only clears the in-editor marker -- it never modifies your file.
Rejecting rewrites the affected lines back to their pre-edit state and saves.

## Commands

| Command | Description |
| --- | --- |
| `Claude Edit Gutter: Review Pending Edits` | Open the status-bar review menu. |
| `Claude Edit Gutter: Approve All Claude Edits` | Clear every pending marker across all files. |

## Manual hook setup (only if you disabled self-install)

Copy `hooks/show-edit-diff.py` to `~/.claude/hooks/` (make it executable) and
add to `~/.claude/settings.json`:

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

## Building from source

No dependencies to install -- the extension is a single `extension.js` plus the
bundled hook. To produce a `.vsix`:

```sh
npx @vscode/vsce package
```

Releases are built automatically: pushing a `v*` tag runs the GitHub Actions
workflow in [.github/workflows/release.yml](.github/workflows/release.yml),
which packages the `.vsix` and attaches it to a GitHub Release.

## License

[MIT](LICENSE)
