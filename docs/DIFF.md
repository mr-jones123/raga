# Git diff dashboard

Use `/diff` inside a Git repository to review changes without leaving raga. The dashboard covers the whole terminal, including the editor and status footer, until you close it. It is built in; no extension installation or external editor is required. The dashboard is read-only: it never stages, resets, checks out, commits, or edits files.

```text
/diff                 Working-tree changes, including untracked files
/diff --staged        Changes staged in the index
/diff HEAD~2          Changes introduced by a specific commit
```

## Review flow

1. Choose a category: **Tests**, **GitHub workflows**, **Modules**, **Documentation**, **Dependencies**, **Configuration**, or **Other**. Each shows its changed-file count.
2. Choose a file and press Enter to open its diff.
3. Scroll through the patch, or press `o` to toggle between the diff and the full file. Full-file mode shows the version belonging to the selected source, not always the current working copy. Deleted files show their previous contents.
4. Escape steps back through the file list and categories, then closes the dashboard. If you selected a commit from the picker, backing out of its categories returns to the picker.

Press `c` to browse commits and select one to review. Commit changes are compared with the first parent; an initial commit is compared with an empty tree. Older history can be reached from the commit picker. Reviewing a commit does not check it out or change your working tree.

## Default controls

| Key | Action |
| --- | --- |
| Up / Down | Navigate lists, or scroll a diff/file three lines at a time |
| Enter | Open selected file or commit |
| Tab / Shift+Tab | Next / previous category |
| PageUp / PageDown | Scroll by a page |
| Home / End | First / last line |
| Left / Right | Scroll long diff/file lines horizontally |
| `o` | Toggle diff / full file |
| `f` | Toggle fullscreen viewer (hides the file list and tabs) |
| Mouse wheel | Scroll (Shift+wheel pans horizontally) in fullscreen terminal mode |
| `c` | Pick a commit |
| `w` | Working-tree changes |
| `s` | Staged changes |
| `r` | Refresh the current source |
| Escape | Back / close |

Dashboard actions use configurable `app.diff.*` bindings; list navigation uses `tui.select.*`. For example, set `"app.diff.commits": "ctrl+k"` in raga's keybindings configuration to change the commit-picker shortcut.

Working-tree mode shows unstaged changes plus untracked files; staged changes have their own view. A file changed both in the index and working copy can appear in both. Renames retain their old path. Binary files show a diagnostic rather than sending binary data to the terminal, and oversized files/diffs are bounded to keep review responsive. Files and commit text are sanitized before rendering terminal controls.
