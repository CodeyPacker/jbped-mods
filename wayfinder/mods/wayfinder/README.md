# wayfinder

Your Boards (kanban) and Pull Requests from GitHub and Azure DevOps, in the side panel beside Files, Changes and Wingman, with a fullscreen mode. Start a space from a Ticket, or a review from a Pull Request. Work in progress: GitHub Projects boards and Ticket detail work today. Azure DevOps, Pull Requests, Launch and Review are still to come.

## Install

1. Copy `mods/wayfinder/` to `~/.config/herdr-app/mods/` and run `herdr-app check ~/.config/herdr-app/mods/wayfinder`.
2. In your layout (a clone of `main`, not a shipped one), add a Wayfinder block to the side panel's stack:

   ```json
   { "id": "wayfinder", "type": "block", "content": { "mod": "wayfinder" } }
   ```

   as a child of `panel-body`. Keep the ids `wayfinder`, `panel`, `panel-body` and `main`: the tab bar button, the palette and fullscreen use them. The `tabs-plus` tab bar shows a Wayfinder button for the block, opens it from the palette (`tabs-plus.wayfinder`), and leaves fullscreen when Wayfinder stops showing.
3. Create `~/.config/herdr-app/data/wayfinder.json` (below).
4. Sign in with the CLIs where the runner runs them: `gh auth login`, and `az login` plus `az extension add --name azure-devops`.

## Use

Tab bar: the Wayfinder button. Palette: `Wayfinder: Open`, `Wayfinder: Close`, `Wayfinder: Fullscreen`, `Wayfinder: Switch Profile`, `Wayfinder: Refresh`. Fullscreen hides the terminals and gives the panel the whole work area. Another panel, Close, or a space with the panel closed puts them back. Click a card to open its detail panel on the right (fields, description, linked Pull Requests, comments). Click another card to switch it. Esc closes the detail panel, then a second Esc leaves fullscreen. To bind a key, add it to `keys.json`, e.g. `"global": { "<key>": { "command": "tabs-plus.wayfinder" } }`.

## Configuration

`~/.config/herdr-app/data/wayfinder.json`:

```json
{
  "activeProfile": "work",
  "profiles": {
    "work": {
      "runner": "wsl:Ubuntu",
      "accounts": [
        { "id": "gh-work", "provider": "github", "login": "<gh user>" },
        { "id": "ado", "provider": "azure", "org": "https://dev.azure.com/<org>", "projects": ["<project>"] }
      ],
      "repos": [{ "id": "frontend", "remote": "<clone url>", "path": "/home/me/src/frontend" }],
      "boards": [
        { "id": "team", "account": "gh-work", "ref": { "owner": "<user or org>", "number": 1 } }
      ]
    }
  }
}
```

- `runner`: where commands run. `native`, or `wsl:<distro>` (the default on Windows, `wsl:Ubuntu`).
- A GitHub account's `login` is a user signed in with `gh` (`gh auth status` lists them).
- A GitHub Board's `ref` is the project's owner and number (from its URL, `github.com/users/<owner>/projects/<number>` or `orgs/<owner>/...`). Its Columns are the `Status` field's options, and every item shows (view filters don't apply). Optional: `statusField` and `priorityField` to use other single-select fields, and a Board `name`. Private and org projects may need `gh auth refresh -h github.com -s read:project`.
- With several Boards, a switcher shows them. "Mine" shows only Tickets assigned to the Account, and is remembered per Board.
- Wayfinder never stores secrets. A field named `token`, `pat`, `password`, `secret`, `accessToken` or `apiKey` is rejected. Sign-in stays with `gh` and `az`.

## Tests

From the repo's `wayfinder/` folder: `node --test test/*.test.js`.
