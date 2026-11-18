# Wranglr

A spaces sidebar that sorts spaces into Groups: one per Repo, one per Workspace, and Custom groups you fill by hand.

![Wranglr](preview.png)

## Features

- **Repo groups.** Every clone and worktree of a Repo, on any Machine, in one group.
- **Workspace groups.** Named lists of Repos from the config file, shown even with no spaces open.
- **Custom groups, Subgroups and drag and drop.** Groups you make and fill by hand, each with optional Subgroups. Drag spaces between groups and drag groups to reorder them.
- **Start or close a group's spaces.** "+" opens the Repo's main checkout or the Workspace home, or makes a git worktree by rules you set. Close group closes every space in it.
- **Automatic names.** New spaces are named `<ticket id> <words>` from their branch.
- **Spaces and Agents tabs.** The Agents tab lists every agent by how much it needs you, each row naming its space. On the Spaces tab, each row shows marks for its agents.
- **Pinned spaces.** Pin a space to the top of the list. Unpinned, it returns to its Group.
- **Tabs under a space.** Expand a space to see its tabs. Click one to open the space at that tab.
- **Machines.** A space on another Machine shows its name. An unreachable one is dimmed, with Connect below the list.
- **Revive.** After Herdr's core restarts, each Claude Code agent that was running is resumed in its terminal with its session.
- **Sorts, folding and an editor file.** Recent, Kind, A-Z or Manual. Click a group's header to fold it. Each Workspace home gets a `<name>.code-workspace` file.
- **Keyboard and palette.** `alt-s` gives the list the keyboard: `j`/`k` move, `enter` opens, `?` lists the rest. Every command is in the `palette` mod.

## Needs

- git. `claude` is used only to name a space whose branch has too many words.
- It replaces the `spaces` block in your layout and rebinds `alt-1` to `alt-9`, `ctrl-shift-pagedown` and `ctrl-shift-pageup`.
- It runs git, reads and writes `~/.config/herdr-app/wranglr.json`, keeps its state in `~/.config/herdr-app/data/wranglr/`, reads Claude Code's session files under `~/.claude/` for an agent's current folder and session, types the resume command into restored terminals, and writes a `<name>.code-workspace` file in each Workspace home. No network of its own.

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

## Use

Click a row to go to the space. Right-click a row, a group or "+" for its menu. In the header, Spaces and Agents switch the list, the sort button cycles the sorts, the folder adds a Custom group and the gear opens settings.

| Key | Action |
|---|---|
| `alt-1` to `alt-9` | go to the space at that position in the list |
| `ctrl-shift-pagedown` / `ctrl-shift-pageup` | next / previous space in the list's order |
| `ctrl-shift-m` | move the focused space to a Group or Subgroup |
| `alt-s` | give the list the keyboard: `j`/`k` move, `enter` opens, `?` lists the keys, `esc` leaves |

It works with no config file. Workspaces, the config file, every command and limits: [`mods/wranglr/README.md`](mods/wranglr/README.md).
