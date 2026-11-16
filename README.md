# herdr-mods

Mods and layouts for the [Herdr](https://herdr.dev) desktop app. Each folder is one share: grab the ones you want.

## wingman

A Cursor-style review pane for coding agents' changes: whole-file diffs with Accept and Reject per change, per file or for everything, undo, rejection notes and comments sent to the agent, syntax highlighting, and editing in the diff. Captures any agent's changes, and every edit Claude Code makes through its hooks. See [`wingman/mods/wingman/README.md`](wingman/mods/wingman/README.md) for install (it adds Claude Code hooks and, on Windows, two user environment variables) and keys.

## palette

A command palette that mods can add entries to: each mod lists its own entries in its `mod.json`, shown first, followed by every Herdr app command with its key. Bind it to `ctrl-shift-p` to replace Herdr's palette. See [`palette/mods/palette/README.md`](palette/mods/palette/README.md).

## agents-plus

Herdr's Agents list with Claude Code's in-process subagents nested under the session that started them. Click a subagent to open its view in Claude Code, and click the parent to go back to `main`. See [`agents-plus/mods/agents-plus/README.md`](agents-plus/mods/agents-plus/README.md) for install (it adds Claude Code hooks) and how it works.

Modified from Herdr's `agents` mod (Apache-2.0, see `agents-plus/LICENSE`).

## wranglr

A spaces sidebar that sorts spaces into Groups: Workspaces (named lists of Repos, from a config file), Repos (every clone and worktree of a Repo on any Machine together) and Custom groups, each with optional Subgroups. Drag spaces and Groups, move a space with a keyboard dialog, pick the sort, and have spaces named `<ticket id> <words>` from their branch. Its own select, next and previous keys follow the list's order. See [`wranglr/mods/wranglr/README.md`](wranglr/mods/wranglr/README.md) for install (it replaces the `spaces` block in your layout and rebinds `alt-1` to `alt-9`) and the config file.

Started from Herdr's `spaces` mod.

## Install

### Tell your agent

wingman, for example:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/jbped/herdr-mods/tree/main/wingman
```

### By hand

Copy a share's `mods/<name>/` folders to `~/.config/herdr-app/mods/` and its `layouts/` files to `~/.config/herdr-app/layouts/`, then run `herdr-app check ~/.config/herdr-app/mods/<name>` for each mod.

## Working on these

Herdr only hot-reloads mods that are real folders in `~/.config/herdr-app/mods/`, so edit them there, not in this repo. Linked folders (junctions) load but don't reload on save. Before committing, copy the changes back:

```sh
./sync.sh                  # every share
./sync.sh wingman          # one share
```

`sync.sh` copies each mod and layout a share folder already has from the config folder, skipping the files Herdr generates (`gpui-kit.d.ts`, `jsconfig.json`). On WSL it finds the Windows config folder on its own. Set `HERDR_HOME` to use another one.
