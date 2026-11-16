# Wingman

A review pane for what coding agents change: whole-file diffs with Accept and Reject per change, per file or for everything.

![Wingman](preview.png)

## Features

- **Capture.** Any agent's changes, by snapshotting the repo when the agent starts working. Every Claude Code edit, in any repo, through its hooks.
- **Review.** Whole-file diffs. Accept or reject one change, the selected lines, a file or everything. Changes stay live on disk meanwhile.
- **Undo.** One history for accepts, rejects and your own edits.
- **Notes to the agent.** A rejection tells the agent which lines were put back, and a save tells it which lines you edited. Each can be turned off.
- **Comments.** Comment on a change, the selected lines or the last rejection. The agent gets it as your message once it is between turns.
- **Edit view.** A file tree of the space's repos with change counts. Open any file, changed or not.
- **Editing.** The diff is an editor: cursor, selection, copy and paste, indent, undo and redo.
- **Autosave and merge.** Saves on focus change or after a pause you set. When the agent writes the file you are editing, both edits are merged.
- **Syntax highlighting.** JavaScript, TypeScript, JSX, Vue, Angular, HTML, CSS, SCSS, C#, JSON, Markdown, YAML, Dockerfiles and `.env`.
- **Your git stays yours.** The index, stash and branch are never touched.

## Needs

- git, and `python3` for the installer.
- Windows, macOS or Linux. On Windows the installer also sets up Claude Code in WSL.
- The installer adds hooks to `~/.claude/settings.json` (backed up first). On Windows it sets `HERDR_WINGMAN_DIR` and adds two `WSLENV` entries.
- It runs git and its own snapshot scripts, and writes review data to `<git-dir>/wingman/` and `~/.config/herdr-app/data/wingman/`. No network.

## Install

Tell your agent:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/jbped/herdr-mods/tree/main/wingman
```

Or by hand:

1. Copy `mods/wingman/` to `~/.config/herdr-app/mods/`.
2. Run the installer from that folder:
   - Windows: `powershell -ExecutionPolicy Bypass -File install\install.ps1 install`, then restart Herdr.
   - macOS and Linux: `sh install/install.sh install`.
3. Run `herdr-app check ~/.config/herdr-app/mods/wingman`.
4. Open it beside an agent: `pane.split` with `{"direction": "right", "mod": "wingman"}`.

## Use

Each Wingman pane shows the review for the space it is in. Right-click a line or change for its menu. The header's gear opens Settings.

| Key | Action |
|---|---|
| `ctrl-y` / `ctrl-n` | accept / reject the selected lines, else the current change |
| `ctrl-shift-enter` / `ctrl-shift-backspace` | accept / reject the file |
| `ctrl-down` / `ctrl-up` | next / previous change |
| `ctrl-shift-down` / `ctrl-shift-up` | next / previous file |
| `ctrl-z` | undo |
| `ctrl-p` / `ctrl-r` | comment on a change / on the last rejection |
| `ctrl-shift-r` / `ctrl-b` | Review or Edit view / file tree |
| `ctrl-s` | save |

Editing keys, settings, the files it writes and uninstall: [`mods/wingman/README.md`](mods/wingman/README.md).
