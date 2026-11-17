# agents-plus

Herdr's Agents list, plus each agent's in-process subagents (Claude Code's Agent tool) nested under it. Herdr's own list nests only subagents started with `hc run`.

- Each subagent shows its description under its parent, with a spinner while it works. The row goes away when the subagent finishes.
- Click a Claude Code subagent row to open that subagent's view in its Claude Code session. Click the parent row to go back to `main`.

Works the same on macOS, Linux, Windows, and Windows with agents in WSL, however the agent was started. There is no hook to install.

## Install

1. Copy `mods/agents-plus/` to `~/.config/herdr-app/mods/` and run `herdr-app check ~/.config/herdr-app/mods/agents-plus`.
2. In your layout, set the agents block's `content.mod` to `agents-plus`. Herdr's own layouts are read-only, so clone one first: `herdr-app do layout.clone '{"name":"main","as":"my-layout"}'`.

## How it works

- herdr-core keeps each terminal's in-process subagents in `records` (`{<id>: {app, state, title}}`). The agent reports them through the terminal itself, so they reach Herdr the same way on every platform. The mod reads them from `terminals()` and adds them as child rows of that terminal's agent.
- A click on a Claude Code subagent focuses the parent pane and moves through Claude Code's footer agent list with `hc keys`, reading the screen with `hc read` after each batch of keys. It presses Enter only once the screen shows the target row selected (`❯`), and checks afterwards that the row is the one shown (`●`). It sends ↑ only while a list row is selected, so it never reaches prompt history. Other agents' subagent rows focus the parent pane.

## Limits

- `records` isn't in Herdr's docs yet, so a Herdr update could change it.
- Clicking depends on how Claude Code draws its footer agent list. If a Claude Code update changes that, the click shows a warning toast and presses nothing that submits.
- The footer row shows a subagent's description only until the subagent reports activity. After that, the click goes by position: it uses the subagent's place in `records` when the footer lists the same number of subagents. If the two lists differ in length, the click shows a warning instead.

Modified from Herdr's `agents` mod (Apache-2.0, see `LICENSE` in this share). Changes: the subagent rows from `records`, the click navigation, and the parent click that goes back to `main`.
