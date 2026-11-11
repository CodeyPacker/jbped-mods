# wingman

Wingman for the Herdr desktop app: a review and editing pane for coding agents' changes. This folder is the share. The mod's own docs (keys, how it works) are in [`mods/wingman/README.md`](mods/wingman/README.md).

## What is here

- `mods/wingman/`: the mod.
- `install.sh`, `install.ps1`: the installer.
- `tests/install/`: tests for the installer. `sh tests/install/run.sh`.

The installer also copies the `tabs-plus` mod from `../tabs-plus/`, so run it from a full clone of the repo.

## Install

Linux and macOS:

```sh
git clone https://github.com/jbped/herdr-mods && sh herdr-mods/wingman/install.sh
```

Windows (PowerShell), in the clone:

```powershell
powershell -ExecutionPolicy Bypass -File wingman\install.ps1
```

On Windows where Claude Code runs in WSL, use `install.ps1`. It also installs the hook in WSL. On WSL with Herdr on Windows, `install.sh` finds the Windows Herdr home itself.

Needs `python3` for `install.sh`. Nothing is downloaded.

## Commands and flags

| | `install.sh` | `install.ps1` |
|---|---|---|
| install (default) | `install` | `install` |
| remove | `uninstall` | `uninstall` |
| show state | `status` | `status` |
| leave layouts alone | `--no-layout` | `-NoLayout` |
| leave the hook alone | `--no-hook` | `-NoHook` |
| print actions, write nothing | `--dry-run` | `-DryRun` |
| uninstall: delete `data/wingman` too | `--purge` | `-Purge` |

Run it again at any time. A second install changes nothing. After you pull new changes, run `install` to copy them over.

## What install changes

Everything is in the Herdr home (`$HERDR_APP_HOME`, else `~/.config/herdr-app`) and the Claude settings file (`$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`).

1. `mods/wingman/` and `mods/tabs-plus/` are copied in. Older copies of these two mods are replaced. A mod folder that is a link is left alone.
2. The active layout gets Wingman's three panel blocks (`wingman-review`, `wingman-edit`, `wingman-changes`) after the blocks already in `panel-body`. Its `tabs` block uses `tabs-plus`, and the panel column's `max` is raised to 2400 if it was lower. Nothing else in the layout changes.
   - If the active layout is your own, it is backed up as `<name>.json.bak-<timestamp>` and patched.
   - If it is one Herdr ships (`main`, `terminals`, `win98`), it is read-only. The installer copies it to `<name>-wingman.json`, patches the copy and switches to it with `herdr-app` when that works. Otherwise press `ctrl-shift-l` or use Settings.
   - If the layout has no `panel-body` stack, nothing changes and the installer prints what to add by hand.
3. The Claude Code hook is added to the Claude settings file. Other hooks stay. A backup is written as `settings.json.bak-herdr-wingman`. On Windows the mod's `install.ps1` also sets the user variables `HERDR_WINGMAN_DIR` and `WSLENV`.

Herdr reloads mods and layouts by itself. Restart Claude Code sessions that were already running, so they load the hook. On Windows, restart Herdr once so new terminals get the variables.

## Undo

```sh
sh wingman/install.sh uninstall
```

This removes the hook, the three blocks and the `tabs-plus` setting from every layout that has them (each is backed up first), and both mod folders. A `<name>-wingman.json` copy stays, restored to Herdr's content, and you can delete it. The panel `max` is left as it is. Your review data in `data/wingman/` is kept unless you add `--purge`.
