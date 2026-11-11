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

Tab bar: the Wayfinder button. Palette: `Wayfinder: Open`, `Wayfinder: Toggle`, `Wayfinder: Close`, `Wayfinder: Fullscreen`, `Wayfinder: Switch Profile`, `Wayfinder: Refresh`. With two or more Profiles, the header shows a switcher for them. Wayfinder shows one Profile at a time, and switching saves it as `activeProfile` in `wayfinder.json` (rewritten as formatted JSON), so it holds across restarts. Fullscreen hides the terminals and gives the panel the whole work area. Another panel, Close, or a space with the panel closed puts them back, and opening Wayfinder again returns to fullscreen. Wayfinder remembers its view (Board, Pull Requests or Settings), Board and Mine choice in every space and across restarts. Click a card to open its detail panel on the right (fields, description, linked Pull Requests, comments). Azure images in the text and attached images show in the panel. Wayfinder saves them through az into `data/wayfinder-images/` in the herdr-app folder and keeps them there. Click another card to switch it, or the Board outside the cards to close it. Arrow keys move between cards (left and right skip empty Columns, Home and End jump in a Column), Enter opens the card, and while the detail panel is open it follows the arrows. Esc closes the detail panel, then a second Esc leaves fullscreen. Toggle shows Wayfinder, or hides it when it is what the panel shows. To bind it to a key, add it to `keys.json`, e.g. `"global": { "ctrl-shift-g": "tabs-plus.wayfinderToggle" }`. The tab bar (tabs-plus) runs it, because a hidden Wayfinder gets no commands.

## Launch and Review

- **Launch** (in a Ticket's detail panel) lists the Board's repos (its `repos`, else every repo in the Profile) and marks those with a worktree already. "Add repo…" picks a local clone and adds it to the Profile and the Board. Launch fetches each repo and adds a worktree at `~/.herdr/worktrees/<id>-<slug>/<repo>` on branch `<id>-<slug>` from the default branch, then opens a space named `<id> <title>` there with the agent, and the Ticket (description, acceptance criteria, repos) as its first message. Launching again reuses the worktrees, and selects the space while it is open.
- **Review** (on each Pull Request row) finds the clone whose `prRepo` is the PR's repo, or asks for it once and saves it. It fetches the PR branch into a detached worktree at `~/.herdr/worktrees/review-<id>/<repo>` and opens a space named `Review <id>`. The agent's first message holds the acceptance criteria of every linked Ticket (GitHub: the body of each issue the PR closes), else the PR description. Nothing is posted to the PR. PRs from forks aren't supported.
- The agent comes from templates: `{ "agent": "claude", "model": "opus", "args": [], "prompt": "…" }`, each field optional. Launch uses `templates.launch` in the file, then the Board's `launch`. Review uses `templates.review`, then the repo's `review`. The defaults run `claude`. The agent starts through the Profile's runner, in a login shell.

## Settings

The Settings icon (the gear) in the header edits `wayfinder.json` for you, and each change is saved at once:

- Profiles: add, show, rename, reorder (the switcher follows this order) or remove (with a second click). The last Profile stays. A rename moves the Profile's `az` login folder and copies its cache to the new name (Herdr can't delete files, so the old cache file stays until you remove it).
- Accounts in the shown Profile: add a GitHub user name or an Azure DevOps organization URL, or remove one (its Boards go with it). An Account that needs signing in shows the command.
- Active Boards: the Boards Wayfinder shows. Untick one to stop following it. For an Azure Board, "Edit displayed statuses" lists its states: tick the ones to show as Columns and order them with the arrows (Tracked Statuses). None ticked means the board's own Columns.
- Other Boards: every other Board each Account can see (GitHub Projects, and the Azure boards of every team you're on), with a search box. Tick one to make it active. Each Account's list folds away, and Wayfinder remembers that.
- Pull Request repos: per Account, All (every repo), Selected (only the ticked repos) or Ignored (every repo except the ticked ones), with a search box. Selected and Ignored keep separate lists, so switching keeps both.

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
      "repos": [{ "id": "frontend", "path": "/home/me/src/frontend", "prRepo": "<owner>/frontend" }],
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
- Azure Accounts list active PRs in the projects of their selected repos, else in every project of the organization (two requests per project): "Mine" uses the creator filter and "Needs my review" the reviewer filter. Azure's reviewer filter matches only you, so PRs that ask one of your teams for a review don't show. Azure has no updated time, so its rows say when the PR was opened. Up to 100 per project and section.
- `prRepos` on an Account filters its Pull Requests: `{ "mode": "selected", "selected": ["owner/name"] }` shows only those, `{ "mode": "ignored", "ignored": [...] }` shows all but those, and leaving it out (or `"all"`) shows every repo. Names are `"owner/name"` for GitHub and `"project/repo"` for Azure. For GitHub the filter applies to the 100 newest matches.
- Board and Pull Request data are cached per Profile in `~/.config/herdr-app/data/wayfinder-cache-<profile>.json`. Refresh loads the shown view: the Board or the Pull Requests. Opening Wayfinder shows the cache at once with its age ("Updated 12m ago"), then refreshes in the background. While Wayfinder shows, it refreshes every 30 minutes. Nothing runs while it is hidden. Refresh re-reads the configuration and refreshes now. A failed refresh keeps the cached Board and shows the error.
- Wayfinder never stores secrets. A field named `token`, `pat`, `password`, `secret`, `accessToken` or `apiKey` is rejected. Sign-in stays with `gh` and `az`.

## Tests

From the repo's `wayfinder/` folder: `node --test test/*.test.js`.
