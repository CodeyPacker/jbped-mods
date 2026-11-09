# wayfinder

Your Boards (kanban) and Pull Requests from GitHub and Azure DevOps, in place of the work area, outside any space. Start a space from a Ticket, or a review from a Pull Request. Work in progress: GitHub Projects boards show today. Ticket detail, Azure DevOps, Pull Requests, Launch and Review are still to come.

## Install

1. Copy `mods/wayfinder/` to `~/.config/herdr-app/mods/` and run `herdr-app check ~/.config/herdr-app/mods/wayfinder`.
2. In your layout (a clone, not a shipped one), wrap the work area node in a stack with a Wayfinder block. For a clone of `main`, replace the `work` column with:

   ```json
   {
     "id": "wayfinder-stack",
     "type": "stack",
     "active": "work",
     "children": [
       { "id": "work", "type": "column", "children": ["...the work column's children, unchanged..."] },
       { "id": "wayfinder", "type": "block", "content": { "mod": "wayfinder" } }
     ]
   }
   ```

   Keep the ids `wayfinder-stack`, `work` and `wayfinder`. The palette entries use them.
3. Create `~/.config/herdr-app/data/wayfinder.json` (below).
4. Sign in with the CLIs where the runner runs them: `gh auth login`, and `az login` plus `az extension add --name azure-devops`.

## Use

Palette: `Wayfinder: Open`, `Wayfinder: Close`, `Wayfinder: Switch Profile`, `Wayfinder: Refresh`. Esc or Close goes back to the work area. To bind a key, add it to `keys.json`, e.g. `"global": { "<key>": { "command": "layout.select", "args": { "stack": "wayfinder-stack", "child": "wayfinder" } } }`.

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
