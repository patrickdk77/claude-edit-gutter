#!/usr/bin/env python3
"""PostToolUse hook: stash the pre-edit content of the just-applied Edit/Write.

Reads the hook JSON on stdin, reconstructs the pre-edit file content, and
writes it under /tmp/claude-edit-diffs-UID/HASH/ together with a .path
sidecar. The claude-edit-gutter VSCode extension watches that directory and
renders the change inside the open editor (gutter marks + line highlight).
Opens no windows or tabs. Runs async so it never blocks the tool call.

This file is installed automatically by the claude-edit-gutter extension;
edits here are overwritten (a .bak is kept) when the extension ships a newer
copy. Change the copy in the extension source if you want to customize it.
"""
import hashlib
import json
import os
import subprocess
import sys
import time

TMPDIR = os.path.join("/tmp", "claude-edit-diffs-%d" % os.getuid())


def log(msg):
    try:
        os.makedirs(TMPDIR, exist_ok=True)
        with open(os.path.join(TMPDIR, "hook.log"), "a") as f:
            f.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


def main():
    data = json.load(sys.stdin)
    tool = data.get("tool_name", "")
    ti = data.get("tool_input") or {}
    tr = data.get("tool_response") or {}
    if not isinstance(tr, dict):
        tr = {}
    fp = ti.get("file_path") or tr.get("filePath")
    if not fp or not os.path.isfile(fp):
        return
    fp = os.path.realpath(fp)
    if fp.startswith("/tmp/"):
        # scratch/temp files are not worth a diff tab
        log("skip (tmp): %s" % fp)
        return
    with open(fp, encoding="utf-8", errors="replace") as f:
        after = f.read()

    # Best source for pre-edit content: the tool response itself
    before = tr.get("originalFile")
    if not isinstance(before, str):
        before = None

    # Edit tool: reconstruct by reversing the replacement
    if before is None and tool == "Edit":
        old = ti.get("old_string")
        new = ti.get("new_string")
        if isinstance(old, str) and isinstance(new, str) and new and new in after:
            if ti.get("replace_all"):
                before = after.replace(new, old)
            else:
                before = after.replace(new, old, 1)

    # Write tool or fallback: diff against git HEAD when the file is tracked
    if before is None:
        d = os.path.dirname(fp)
        try:
            rel = subprocess.run(
                ["git", "-C", d, "ls-files", "--full-name",
                 "--error-unmatch", "--", fp],
                capture_output=True, text=True, timeout=10)
            if rel.returncode == 0:
                show = subprocess.run(
                    ["git", "-C", d, "show", "HEAD:" + rel.stdout.strip()],
                    capture_output=True, text=True, timeout=10)
                if show.returncode == 0:
                    before = show.stdout
        except Exception:
            pass

    if before is None:
        before = ""  # brand-new untracked file: diff against empty

    if before == after:
        log("skip (no change): %s" % fp)
        return

    tag = hashlib.sha1(fp.encode()).hexdigest()[:8]
    os.makedirs(os.path.join(TMPDIR, tag), exist_ok=True)
    # sidecar first so the extension's watcher can always resolve the path
    with open(os.path.join(TMPDIR, tag, ".path"), "w", encoding="utf-8") as f:
        f.write(fp)
    before_path = os.path.join(TMPDIR, tag, os.path.basename(fp))
    with open(before_path, "w", encoding="utf-8") as f:
        f.write(before)
    log("stash updated: %s" % fp)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log("error: %r" % e)
    sys.exit(0)
