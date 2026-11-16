# Wranglr

A spaces sidebar that sorts spaces into Groups: one per Repo, one per Workspace, and Custom groups you fill by hand.

![Wranglr](preview.png)

## Features

- Repo groups: every clone and worktree of a Repo, on any Machine, in one group.
- Workspace groups: named lists of Repos from a config file, shown even with no spaces open.
- Custom groups and Subgroups. Drag spaces and groups, or move a space with `ctrl-shift-m`.
- "+" on a group starts a space there: in the main checkout, in a new git worktree, or on another Machine.
- New spaces are named `<ticket id> <words>` from their branch.
- Agent status marks on each row, and four sorts: Recent, Kind, A-Z and Manual.

## Needs

- git. `claude` is used only to name a space whose branch has too many words.
- It replaces the `spaces` block in your layout and rebinds `alt-1` to `alt-9`, `ctrl-shift-pagedown` and `ctrl-shift-pageup`.
- It runs git, reads and writes `~/.config/herdr-app/wranglr.json`, keeps its state in `~/.config/herdr-app/data/wranglr/`, and writes a `<name>.code-workspace` file in each Workspace home. No network of its own.

## Install

Tell your agent:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/jbped/herdr-mods/tree/main/wranglr
```

Or by hand:

1. Copy `mods/wranglr/` to `~/.config/herdr-app/mods/`.
2. In your own layout (clone a shipped one with `layout.clone`), set the spaces block to `"content": { "mod": "wranglr" }`.
3. Merge `keys.json` into `~/.config/herdr-app/keys.json`.
4. Run `herdr-app check ~/.config/herdr-app/mods/wranglr`.

It works with no config file. Workspaces, commands, the config file and limits: [`mods/wranglr/README.md`](mods/wranglr/README.md).
