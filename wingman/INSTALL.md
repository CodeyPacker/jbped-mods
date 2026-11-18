# Wingman installer

The installer for [Wingman](README.md). The mod's own docs (keys, how it works) are in [`mods/wingman/README.md`](mods/wingman/README.md).

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
2. The active layout is edited in four ways. Each edit keeps what it replaced inside the node, so uninstall undoes exactly it:
   - Three blocks are added after the blocks already in `panel-body`: `wingman-review`, `wingman-edit`, `wingman-changes`, each with `props.added: true`.
   - The `tabs` block's mod `tabs` becomes `tabs-plus`, the old mod kept in `props.replaces`.
   - The panel column's `max` is raised to 2400 when it was lower. The old value is kept in `props.max_was` of the first Wingman block.
   - The capture controller `wingman-capture` is added last to the layout root's `floating` list, with `props.added: true`, and `props.list_added: true` when the layout had no `floating` list.

   Nothing else in the layout changes.
   - If the active layout is your own, it is backed up as `<name>.json.bak-<timestamp>` and edited.
   - If it is one Herdr ships (listed as `layout:<name>` in `installed.json`: `main`, `terminals`, `win98`), it is read-only. The installer copies it once to `<name>-copy.json` (with `cloned_from`, like Herdr's Duplicate layout), edits the copy and switches to it with `herdr-app` when that works. Otherwise press `ctrl-shift-l` or use Settings. An earlier install's `<name>-wingman.json` is reused if it exists.
   - If the layout has no `panel-body` stack, nothing changes and the installer prints what to add by hand.
3. The Claude Code hook is added to the Claude settings file. Other hooks stay. A backup is written as `settings.json.bak-herdr-wingman`. On Windows the mod's `install.ps1` also sets the user variables `HERDR_WINGMAN_DIR` and `WSLENV`.

Herdr reloads mods and layouts by itself. Restart Claude Code sessions that were already running, so they load the hook. On Windows, restart Herdr once so new terminals get the variables.

## Undo

```sh
sh wingman/install.sh uninstall
```

This removes the hook, the three blocks, the capture controller, the `tabs-plus` switch and the raised `max` from every layout that has them (each is backed up first), and both mod folders. The layout is back as it was: byte for byte when the file was in Herdr's own JSON style, node for node otherwise. A `<name>-copy.json` copy stays as yours, without Wingman, and you can delete it. A layout an older install patched has no markers: its blocks are removed, its `tabs-plus` and `max` stay.

It also removes Wingman's own bindings (values starting `wingman.`) from the `mod:wingman` section of `keys.json`, and nobody else's. The installer never adds keys. The running mod writes its `mod:wingman` entries itself, only for keys Herdr binds globally, and never replaces a binding that isn't Wingman's.

If the setting "Hide Herdr's Files and Changes buttons" is on, uninstall turns it off and puts back the entries Wingman removed from `workspace.panels`: through the running mod when `herdr-app` answers (set `HERDR_APP_BIN` to its path if it isn't on PATH), else in `shared.json` directly. Your review data in `data/wingman/` is kept unless you add `--purge`.
