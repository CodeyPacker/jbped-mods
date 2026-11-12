# herdr-mods

Mods and layouts for the Herdr desktop app. Each top-level folder is one share.

## Language

### Wayfindr

**Wayfindr**:
The mod that shows a Board and the user's open Pull Requests, and starts Herdr spaces from Tickets and Pull Requests. It lives outside any space.

**Profile**:
A named, separate set of Accounts, such as Work or Personal. Wayfindr shows exactly one Profile at a time.
_Avoid_: workspace, environment, context

**Account**:
One signed-in identity on one Provider, belonging to one Profile.
_Avoid_: login, connection, credential

**Provider**:
An external work-tracking or code-hosting service Wayfindr reads from: GitHub, Azure DevOps, or ClickUp. Each Provider plugs into one shared Wayfindr flow and never owns its own end-to-end path.
_Avoid_: integration, service, source

**Board**:
A Provider's view of active work, shown as the Provider shows it today: a GitHub Projects board, an Azure DevOps team board or sprint board, or a ClickUp List. Backlogs are not Boards.
_Avoid_: project, kanban, backlog

**Followed Board**:
A Board the Profile lists, so Wayfindr shows it. Settings ticks a Board to follow it and unticks it to stop.
_Avoid_: active board, selected board, subscribed board

**Column**:
One stage of a Board. Its name and order come from the Provider's board, or from the Board's Tracked Statuses when it has them.
_Avoid_: lane, status bucket

**Tracked Statuses**:
An ordered list of Provider states the user picks for a Board. Each state becomes one Column, left to right in the saved order, on any Provider.
_Avoid_: status filter, custom columns

**Ticket**:
One work item on a Board, whatever the Provider calls it (issue, work item, task).
_Avoid_: item, card, task, issue, work item

**Move**:
Changing the Column a Ticket is in. It was the first write Wayfindr supported; title edits and comments followed.
_Avoid_: transition, status change

**Pull Request**:
An open or draft pull request the user authored or is asked to review, in GitHub or Azure DevOps.
_Avoid_: PR list item, merge request

**Repo Filter**:
Which repos' Pull Requests an Account shows: All, Selected (only the listed repos) or Ignored (every repo but the listed ones).
_Avoid_: whitelist, blacklist, allow list, block list

**Repo**:
A local clone the Profile lists, with its folder and, once known, the Pull Request repo it clones. A Board names the Repos a Launch makes worktrees from, and a Review uses the Repo whose Pull Request repo matches.
_Avoid_: repository, checkout, project

**Checkout Mode**:
How a Review puts the Pull Request's branch into a Repo: Worktree (a detached worktree at the Repo's Worktree Placement, the default) or Branch (the branch checked out in the Repo's own folder, created from origin when new).
_Avoid_: review mode, clone mode, checkout type

**Worktree Placement**:
Where a Repo's worktrees go: Wranglr's rule for that Repo (the default; Herdr's worktrees folder when Wranglr is not set up), Herdr's worktrees folder, beside the clone, or a folder the user chose. A Launch and a Worktree-mode Review place each Repo's worktree by it.
_Avoid_: worktree root, worktree dir, checkout location

**Template**:
The agent, model, extra arguments and opening prompt a Launch or Review starts with. A Launch Template is the file's default, then the Board's; a Review Template is the default, then the Repo's.
_Avoid_: preset, agent profile

**Review**:
Starting a new Herdr space on a Pull Request's branch, in its own worktree, where an agent checks it against acceptance criteria, security, and code quality.
_Avoid_: PR check, code review session

**Launch**:
Starting a new Herdr space from a Ticket, with a worktree for each repo the Ticket touches and the Ticket as the agent's opening prompt.
_Avoid_: kick off, spawn

### Tiling

**Dwindle**:
A way of adding panes to a tab: each new pane splits the focused pane, alternating side by side and stacked as the split chain gets deeper. Only panes the user adds through Dwindle follow this rule.
_Avoid_: spiral, binary tiling
