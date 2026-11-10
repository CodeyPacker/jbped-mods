# wayfinder

Your Boards (kanban) and Pull Requests from GitHub and Azure DevOps, in the side panel beside Files, Changes and Wingman, with a fullscreen mode. Start a space from a Ticket, or a review from a Pull Request. Work in progress: GitHub Projects boards and Azure DevOps team boards, with Ticket detail, work today. Pull Requests, Launch and Review are still to come.

## Install

1. Copy `mods/wayfinder/` to `~/.config/herdr-app/mods/` and run `herdr-app check ~/.config/herdr-app/mods/wayfinder`.
2. In your layout (a clone of `main`, not a shipped one), add a Wayfinder block to the side panel's stack:

   ```json
   { "id": "wayfinder", "type": "block", "content": { "mod": "wayfinder" } }
   ```

   as a child of `panel-body`. Keep the ids `wayfinder`, `panel`, `panel-body` and `main`: the tab bar button, the palette and fullscreen use them. The `tabs-plus` tab bar shows a Wayfinder button for the block, opens it from the palette (`tabs-plus.wayfinder`), and leaves fullscreen when Wayfinder stops showing.
3. Create `~/.config/herdr-app/data/wayfinder.json` (below).
4. Sign in with the CLIs where the runner runs them: `gh auth login`, and for Azure the per-Profile `az login` that Wayfinder shows (below).

## Use

Tab bar: the Wayfinder button. Palette: `Wayfinder: Open`, `Wayfinder: Close`, `Wayfinder: Fullscreen`, `Wayfinder: Switch Profile`, `Wayfinder: Refresh`. With two or more Profiles, the header shows a switcher for them. Wayfinder shows one Profile at a time, and switching saves it as `activeProfile` in `wayfinder.json` (rewritten as formatted JSON), so it holds across restarts. Fullscreen hides the terminals and gives the panel the whole work area. Another panel, Close, or a space with the panel closed puts them back. Click a card to open its detail panel on the right (fields, description, linked Pull Requests, comments). Click another card to switch it. Esc closes the detail panel, then a second Esc leaves fullscreen. To bind a key, add it to `keys.json`, e.g. `"global": { "<key>": { "command": "tabs-plus.wayfinder" } }`.

## Settings

The Settings button edits `wayfinder.json` for you, and each change is saved at once:

- Profiles: add one, show one, or remove one (with a second click). The last Profile stays. A Profile's name is also its cache file and `az` login folder, so it can't be renamed.
- Accounts in the shown Profile: add a GitHub user name or an Azure DevOps organization URL, or remove one (its Boards go with it). An Account that needs signing in shows the command.
- Boards: every Board each Account can see (GitHub Projects, and the Azure boards of every team you're on). Tick the ones to follow. For an Azure Board, Statuses lists its states: tick the ones to show as Columns and order them with the arrows (Tracked Statuses). None ticked means the board's own Columns.
- Pull Request repos: tick the repos whose PRs you want. Following none shows all. The filter box narrows the list.

Refresh reloads the lists. A change that would make the file invalid is refused with the reason, and if the file changed elsewhere, Wayfinder reads it again instead of overwriting it.

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
        { "id": "team", "account": "gh-work", "ref": { "owner": "<user or org>", "number": 1 } },
        { "id": "sprint", "account": "ado", "ref": { "project": "<project>", "team": "<team>" } }
      ]
    }
  }
}
```

- `runner`: where commands run. `native`, or `wsl:<distro>` (the default on Windows, `wsl:Ubuntu`).
- A GitHub account's `login` is a user signed in with `gh` (`gh auth status` lists them).
- A GitHub Board's `ref` is the project's owner and number (from its URL, `github.com/users/<owner>/projects/<number>` or `orgs/<owner>/...`). Its Columns are the `Status` field's options, and every item shows (view filters don't apply). Optional: `statusField` and `priorityField` to use other single-select fields, and a Board `name`. Private and org projects may need `gh auth refresh -h github.com -s read:project`.
- Any Board can set `trackedStatuses`, an ordered list of states (Azure `State`, GitHub `Status` values). Each becomes one Column in that order, so two states that share a web-board column show apart, and Tickets in other states are hidden. Case doesn't matter. Leave it out to use the Provider's own columns.
- An Azure Board's `ref` is the `project` and `team`, plus an optional `board` (its name, e.g. `Stories` or `Features`; the team's first board by default). Its Columns are the team board's, in order. Azure has no list of a board's items, so Wayfinder rebuilds it: the board's work item types on the team's area paths, in backlog order, each in the Column the team's board field says. Items in the last Column show if they changed in the last 30 days. Swimlanes are ignored, and "View in Azure" opens the real board.
- Azure Ticket detail converts the HTML fields to markdown. A Bug shows its repro steps where the description goes, and acceptance criteria get their own section. Linked Azure pull requests show with their state. GitHub pull request links show by URL only. The last 100 comments show, oldest first.
- Each Profile has its own `az` login in `~/.config/wayfinder/azure/<profile>` (inside the runner), so two Profiles never share Azure credentials. "Sign in needed" shows the exact `az login` command for it. Every refresh gets a fresh token.
- With several Boards, a switcher shows them. "Mine" shows only Tickets assigned to the Account, and is remembered per Board.
- Each Account's sign-in is checked with `gh auth status` on every refresh. A missing or expired login, or a Board Account without `read:project`, shows "Sign in needed" with the exact command and a button that runs it in a new tab through the runner. gh refreshes only its active account, so for another account the command switches to it and back. The Profile's other Accounts keep working. Press Refresh afterwards.
- Pull Requests lists each GitHub Account's open PRs in two sections: "Mine" (open and draft PRs it authored, drafts marked) and "Needs my review" (open PRs that request its review, directly or through a team). Both come from one GitHub search request per Account, across every repo the login can see, grouped by Account, then repo. Up to 100 per section are shown, with a count of the rest. "Open in browser" opens the PR.
- Azure Accounts list active PRs in each project of their followed repos, else of their `projects` (two requests per project): "Mine" uses the creator filter and "Needs my review" the reviewer filter. Azure's reviewer filter matches only you, so PRs that ask one of your teams for a review don't show. Azure has no updated time, so its rows say when the PR was opened. Up to 100 per project and section.
- `followedRepos` on an Account (`"owner/name"` for GitHub, `"project/repo"` for Azure) limits its Pull Requests to those repos. Leave it out to see them all. For GitHub the filter applies to the 100 newest matches.
- Board and Pull Request data are cached per Profile in `~/.config/herdr-app/data/wayfinder-cache-<profile>.json`. Refresh loads the shown view: the Board or the Pull Requests. Opening Wayfinder shows the cache at once with its age ("Updated 12m ago"), then refreshes in the background. While Wayfinder shows, it refreshes every 30 minutes. Nothing runs while it is hidden. Refresh re-reads the configuration and refreshes now. A failed refresh keeps the cached Board and shows the error.
- Wayfinder never stores secrets. A field named `token`, `pat`, `password`, `secret`, `accessToken` or `apiKey` is rejected. Sign-in stays with `gh` and `az`.

## Tests

From the repo's `wayfinder/` folder: `node --test test/*.test.js`.
