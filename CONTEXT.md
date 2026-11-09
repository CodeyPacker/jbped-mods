# herdr-mods

Mods and layouts for the Herdr desktop app. Each top-level folder is one share.

## Language

### Wayfinder

**Wayfinder**:
The mod that shows a Board and the user's open Pull Requests, and starts Herdr spaces from Tickets. It lives outside any space.

**Profile**:
A named, separate set of Accounts, such as Work or Personal. Wayfinder shows exactly one Profile at a time.
_Avoid_: workspace, environment, context

**Account**:
One signed-in identity on one Provider, belonging to one Profile.
_Avoid_: login, connection, credential

**Provider**:
An external work-tracking or code-hosting service Wayfinder reads from: GitHub, Azure DevOps, or ClickUp. Each Provider plugs into one shared Wayfinder flow and never owns its own end-to-end path.
_Avoid_: integration, service, source

**Board**:
A Provider's view of active work, shown as the Provider shows it today: a GitHub Projects board, an Azure DevOps team board or sprint board, or a ClickUp List. Backlogs are not Boards.
_Avoid_: project, kanban, backlog

**Column**:
One stage of a Board. Its name and order come from the Provider's board, or from the Board's Tracked Statuses when it has them.
_Avoid_: lane, status bucket

**Tracked Statuses**:
An ordered list of Provider states the user picks for a Board. Each state becomes one Column, left to right in the saved order. Azure DevOps only for now.
_Avoid_: status filter, custom columns

**Ticket**:
One work item on a Board, whatever the Provider calls it (issue, work item, task).
_Avoid_: item, card, task, issue, work item

**Move**:
Changing the Column a Ticket is in. It is the first write Wayfinder will support.
_Avoid_: transition, status change

**Pull Request**:
An open or draft pull request the user authored, in GitHub or Azure DevOps.
_Avoid_: PR list item, merge request

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
