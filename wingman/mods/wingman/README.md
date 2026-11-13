# Wingman

A Herdr pane that shows the code changes coding agents make, Cursor-style: whole-file diffs with Accept and Reject on every change, per file, or for everything. Changes stay live on disk while you review. Accept keeps them. Reject restores the original lines. Ctrl+Z undoes either.

## How changes are found

- **Any agent.** When an agent in a space starts working, the mod snapshots every repo of the space's workspace at once (`snapshot.ps1` / `snapshot.sh`). Files that change while it works become reviewable, each with what was on disk before as its baseline (git's own line-ending rules give it back exactly). Your real git index, stash and branch are never touched. A text file over 1 MB isn't reviewed (Herdr doesn't read files that large): it's skipped and logged, and the other files are captured as usual.
- **Claude Code**, through its hooks (`hooks/wingman-hook.sh`). Every Edit/Write is reported with the file's exact content before the edit, so the review covers every repo Claude edits, not just the one it started in.

When you reject a change, the agent that made it gets a short factual note on its next tool call or prompt: what was rejected and that the original lines are back. This keeps its picture of the file right. Turn it off in **Settings**. **Comment last rejection** (`ctrl-r`) sends your own comment with it. **Ask** (`ctrl-m`) sends an instruction about a change or the selected lines, such as "refactor this into a helper". It's typed into the agent's terminal as your message, waiting until the agent isn't mid-turn.

**Review comments** collect notes to send as one prompt. Add one with a change's **Comment** button in Review, **+ Comment** or `alt-m` on the cursor's line or the selection in Edit, or the right-click menu (**Add review comment**, **Reject and add review comment…**, which rejects the change and quotes it). The header's **Comments N** (`alt-shift-m`) lists the space's comments: jump to one, edit, delete, **Clear all**, **Copy prompt**, and **Send to agent**, which types them into the agent's terminal as your message with `hc send` (paste and Enter) and clears the list; **Undo clear** puts the last sent or cleared batch back until you add a comment. Send goes to the agent that made the commented changes when they all name the same live one, else the space's only agent, else it asks which; a working agent asks first. Comments are kept per space in `data/wingman/comments/` and follow their code when the file changes; one whose lines can't be found again is marked "moved or changed". At most 50 comments per space and 2,000 characters per comment; control characters are dropped.

Syntax highlighting (Prism 1.30, MIT, vendored in `prism.js` and `grammars.js`) covers JavaScript, TypeScript (`.ts .mts .cts .d.ts`), React (`.jsx .tsx`, and JSX in `.js`), Vue (`.vue`), Angular (`.ts` and `.html` templates with `{{ }}`), HTML, C#, JSON, Markdown, Dockerfiles, YAML (including `docker-compose.yml`) and `.env` files. CSS (`.css`) and SCSS (`.scss`) are covered too. In HTML and Vue files, `<script>` blocks use the grammar their `lang` names and `<style>` blocks use CSS or SCSS. Vue and Angular template syntax is recognized: `v-if`, `v-for`, `:prop`, `@event`, `#slot`, `[prop]`, `(event)`, `[(ngModel)]`, `*ngFor`, `#ref`, `@if`/`@for`/`@switch`/`@defer` blocks and `{{ }}`, with the expressions inside highlighted as JavaScript. Other files show as plain text.

Review shows only what belongs to this space and branch:
- **Branch:** each change records the branch it was made on. Switching branches sets it aside, and it comes back when you switch back. A worktree has its own review anyway.
- **Space:** only changes made by the space's own agents show. A repo shared with another space doesn't bring that space's changes along.
- **Committed:** once a change is committed (the file on disk is what `HEAD` has, and `HEAD` has what the file had while it differed from `HEAD`: the agent's change and any edit after it), it leaves Review and shows in Changes under "Committed on this branch", marked AI. A change set aside meanwhile (`git stash` and a pull, `git checkout -- file`) stays in Review and is never marked as committed. Wingman looks every few seconds, so a file edited and committed from a terminal within that time can stay in Review (Commit in Changes looks first).

Changes recorded before Wingman kept branches take the branch the repo is on, and the space of the agent that made them while it's still open.

Each repo's review lives in `<git-dir>/wingman/`. Git never tracks or pushes that folder. Files outside any git repo are not reviewed.

### Workspaces: several repos in one space

A space reviews every repo in its workspace, which is made up of:
- the repo of every terminal's folder in the space (agents or not), and every repo Claude edited,
- the folders of a VS Code workspace file (`*.code-workspace`) in the space's folder. Wayfinder's Launch writes one into the Ticket folder, listing one worktree per repo,
- repos you add yourself.

A terminal's folder outside any git repo, or a workspace folder that isn't a repo, is a plain folder: the Edit tree lists it and its files open, edit and save, but nothing is reviewed or captured there, and Changes and Quick Open leave it out. Next to a repo, a plain folder starts collapsed. Its header has a ⟳ button that lists its open folders again. Its open folders are also relisted on their own, one folder at a time, at most every 30 seconds. A home folder is never searched for a repo, and is listed one level at a time like any plain folder.

Folders can nest: a terminal in a ticket folder that isn't a repo, with the space's worktrees inside it, or a worktree folder inside another repo, or terminals in a folder and in a subfolder of it. A file belongs to the innermost repo or folder of the space that holds it, a repo before a plain folder, and has one tab and one buffer however it's reached. In the outer folder's tree, an inner one shows as a link (`↗ name → root`): a click, Enter or Right goes to that root's own entry, and its files are never listed, opened, renamed or deleted through the outer folder. A file opened, created or moved into an inner root through the outer one opens as the inner root's file, and a repo's saves always go through its review. Renaming or deleting an inner root, or a folder holding one, from the outer tree is refused. Changes and Quick Open list a nested repo's files under that repo only.

With more than one repo or folder, the Edit tree shows each as a top-level entry, with its name (the file's `name`, else the folder), its open change count and a × to remove it. **+ Add repo…** under the tree (with Search in the left column, it switches to Explorer, where its panel shows) takes:
- a repo,
- a folder of repos, listing the repos inside it to tick,
- a main clone while the space's worktrees share a branch. Wingman offers to make a worktree for it beside them, on that branch (fetching first, then branching from the remote's default branch when the branch is new).

Removing asks first. A removed repo or folder stays out even while a terminal is still in it. Open changes come back when you add the repo again. For a worktree, you choose whether to delete it too (`git worktree remove`, which refuses while it has uncommitted or untracked files).

The workspace file uses VS Code's format: `{"folders": [{"path": "api"}, {"path": "../web", "name": "Web"}], "settings": {}}`. Paths are relative to the file or absolute, and comments are allowed. When a folder has several, Wingman reads the one named after the folder, else the first by name, and rereads it whenever it changes. When Wingman edits it, only `folders` changes, so every other key, comment and the order stay as they were. A space with one repo has no file. Adding a second repo makes one, in the space's folder, named after that folder. If the folder is inside a repo, or is the home folder, the file goes to `data/wingman/workspaces/<space>.code-workspace` with absolute paths instead. VS Code and Cursor can open either.

Nothing here changes Herdr's spaces or other mods: Herdr's Files and Changes panels still show only the space's folder.

### Which git runs

Linux and macOS use the machine's own `git`. On Windows, Wingman decides for each repo:
- **WSL's git** (through `wsl.exe`, with `/mnt/<drive>` paths) for repos WSL owns: repos inside WSL's own files (`\\wsl.localhost\<distro>\...`), worktrees WSL git added (their `.git` file points to a `/mnt` path, which Windows git can't open), and repos WSL git made (`core.filemode = true`, which Windows git never sets). Capture runs `snapshot.sh` there, the same as on Linux.
- **Git for Windows** for everything else, with file modes ignored, since Windows can't record executable files. If Git for Windows isn't installed, WSL's git is used.

WSL git on a Windows drive is slow (about 1.5 s per `git status` on a large repo), so Wingman's polls never overlap. Keeping WSL repos in WSL's own files avoids that.

### Other machines

A space on another machine (Herdr's `machine`, reached over ssh) works in every tab, with every git and file call running on that machine:

- **Edit**: the tree of the space's repos and plain folders (from its terminals' folders, as that machine names them), with git status letters and dimmed ignored files. Files open, edit and save as they do here: typing, line operations, Find and Replace, save and autosave, the merge of an agent's write into unsaved edits, and the conflict banner.
- **Review**: any agent's changes there are captured (a snapshot of each repo when it starts working, then new changes adopted at most every 5 s while it works and once after), with Accept, Reject and undo. The review store is `<git-dir>/wingman/` on that machine, as here. Claude's edits there are captured like any agent's, and, with the Claude hook installed there (see Install), reported by the hook as they are here: each edit's baseline is Claude's own `originalFile`, the review covers every repo Claude edits there, and rejection notes, edit notes and **Comment last rejection** reach that Claude.
- **Changes**: the uncommitted list with letters, line counts and AI marks, each file's diff, "Committed on this branch", **Commit** and **Discard file**. The diffs are computed here from texts read there.
- **Quick Open**, **Search** and **Replace All** over its repos' files.
- **Workspaces**: a `*.code-workspace` in the space's folder there is read and edited there, and made there when adding a repo makes two (unless that folder is inside a repo or is a home folder). Otherwise repos you add by hand (**+ Add repo…** takes a path on that machine) go to `data/wingman/workspaces/<space>.code-workspace` here, holding that machine's paths. Worktrees are made and deleted there as here.

Every save there is compare-and-swap: the content goes to a temp file beside the file (`.wingman-<id>.tmp`), the file's SHA-256 is checked against what Wingman last read, and the temp file is renamed over it, keeping its mode and following a link. A file that changed meanwhile isn't overwritten. A file that isn't plain UTF-8 text isn't saved there.

Without the Claude hook installed there, notes to Claude about rejections and your edits aren't sent, and **Comment last rejection** says so; **Comment** still types into the agent's terminal. Neovim and the external editor don't open files there. A Windows machine (one without `sh`) can be browsed but not saved to: it says "Saving on a Windows machine isn't supported yet".

Each call there takes about 150 to 200 ms, so an idle space is polled less often than a local one: its folders every 5 s (its workspace file at most every 30 s), Changes every 5 s (one `git status` and one `git hash-object` per repo), the tree every 10 s (two git calls per repo), and Review's index and the open files every 5 s (one call for all of them, which is how an outside change to an open file is noticed). Review's branch parking and committed changes are checked every 15 s, only while the space is shown or an agent there works. The Claude hook's events folder there is listed every 5 s (every 30 s while the hook isn't installed), only while a space there with a Wingman panel and an agent is shown or that agent works, and once after: one call, plus a few calls per event (reading it, the review store's writes, and one call removing the events read). A save is one call up to about 27 KB, and larger files go in pieces of that size, about 0.2 s each (a 200 KB file took 1.5 s), unless the machine takes 1 MB per call, which Wingman checks once. A call there that never answers fails with "… timed out" (a read after 20 s, anything else after its own limit plus 10 s), so saves queued behind it go on.

The machine needs `git`, `sh`, and `sha256sum` (or `shasum` or `openssl`). Only a Linux machine (WSL through Herdr) has been tried.

## Install

Copy this folder to `~/.config/herdr-app/mods/wingman/`, then run the installer once.

**Windows** (PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.config\herdr-app\mods\wingman\install\install.ps1" install
```

This makes three changes:

1. Sets the user variable `HERDR_WINGMAN_DIR` to `%USERPROFILE%\.config\herdr-app\data\wingman`, where the hook saves edit events.
2. Adds `HC_TERMINAL_ID:HERDR_WINGMAN_DIR/p` to the user variable `WSLENV`, keeping existing entries. This lets a Claude running in WSL tell which Herdr terminal it is in, and see the folder as `/mnt/c/...`.
3. Runs `install.sh` inside WSL, which adds the hooks to WSL's `~/.claude/settings.json`.

Restart Herdr afterwards. Terminals started before the restart don't get the new variables.

**macOS / Linux**:

```sh
sh ~/.config/herdr-app/mods/wingman/install/install.sh install
```

This adds the hooks to `~/.claude/settings.json` and creates `~/.config/herdr-app/data/wingman`. No environment setup is needed.

The installer keeps your other hooks and writes `settings.json.bak-herdr-wingman` first. Running it again changes nothing. It needs `python3` to edit the JSON. The hook itself is plain `sh`.

**Another machine** (a space on a Herdr machine reached over ssh, or a WSL machine of this PC): open a space there, then **⚙ Settings** › **Claude hook on <machine>** › **Install**. Nothing is needed on the machine but `sh`. It makes, on that machine:

1. The folder `~/.config/herdr-app/data/wingman/` (or `$HERDR_WINGMAN_DIR` when that's set there), with `events/` and `feedback/`. The hook does nothing on a machine without this folder.
2. `wingman-hook.sh` in that folder, a copy of this mod's hook. Claude runs it as `sh '<path>'`, so it needs no execute bit.
3. Two entries in `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` there, the same ones `install.sh` adds here: a `PostToolUse` hook on `Edit|Write|MultiEdit|NotebookEdit` running `sh '<folder>/wingman-hook.sh' post # herdr-wingman-hook`, and a `UserPromptSubmit` hook running it with `prompt`, each with a 10 s timeout. Other keys and hooks are kept, `settings.json.bak-herdr-wingman` is written first, and a file that isn't valid JSON is left alone with an error. Wingman edits the JSON itself, so the machine needs no `python3`.
4. `wingman-install.json` in that folder, recording which folders it made.

Restart Claude there afterwards. Install again changes nothing (or updates the hook copy when this Wingman's is newer). The section's status line says what's there: installed, not installed, or installed by this PC's WSL setup.

A WSL machine of this PC may already have the hook from `install.ps1` (its entries run the Windows copy through `/mnt/c/...`). Install then adds no second entry and only makes the folder. In that machine's terminals the hook uses the machine's own folder, not the Windows one `WSLENV` hands in, because their terminal ids belong to that machine's Herdr core.

Inside a terminal there, `HC_TERMINAL_ID` is that machine's own id (`t3`). The hook writes that id; Wingman reads it as Herdr's address for the terminal (`wsl/t3`), and names its notes for that Claude by the bare id, as the hook reads them.

## Uninstall

Run the same installer with `uninstall`. It removes only what install added: its hook entries, `HERDR_WINGMAN_DIR`, and its two `WSLENV` entries. Then delete this folder. To clear review data, delete `~/.config/herdr-app/data/wingman*` and any repo's `.git/wingman/`.

On another machine: **⚙ Settings** › **Claude hook on <machine>** › **Remove**. It removes the two entries it added (a backup first; entries it didn't add, such as this PC's WSL setup's, stay), the hook copy and its record, and the folders it made, with any events and notes still waiting in them. A settings file Install created and that is left empty goes too.

## Use

Open a Wingman pane beside an agent: run `pane.split` with `{"direction": "right", "mod": "wingman"}`, for example from the palette or a key in `keys.json`. Each pane shows the review for the space it's in.

Or put Wingman in the side panel beside Files and Changes, as two panel tabs, Review and Edit. In a layout of your own (a clone, since Herdr's shipped layouts are read-only), add two blocks to the `panel-body` stack: `{"id": "wingman-review", "type": "block", "content": {"mod": "wingman", "props": {"view": "review"}}}` and the same with `wingman-edit` and `"view": "edit"`. Raise the `panel` column's `max` (for example to 2400), and point the `tabs` block at a clone of the `tabs` mod that draws a button per Wingman block. The `tabs-plus` clone does that. It also takes the commands `tabs-plus.wingmanReview` and `tabs-plus.wingmanEdit`, which the palette entries **Wingman: Review** and **Wingman: Edit** run to select the tab and show the panel. It keeps a width per panel tab: Review and Edit open at 960px the first time and then at whatever width you drag them to.

A third block, `{"id": "wingman-changes", "type": "block", "content": {"mod": "wingman", "props": {"view": "changes"}}}`, adds the **Changes** tab (palette: **Wingman: Changes**, command `tabs-plus.wingmanChanges`).

### Changes

Every uncommitted change in the space's repos, against `HEAD`: your edits, other tools', and the agent's from before Wingman started capturing. The list on the left shows each file's status (A added or untracked, M modified, D deleted, ! conflict), its added and deleted line counts (`+12 −3`, none for binary files), and what Review says about it ("2 to review", "reviewed"). The list header shows the totals. The diff is read-only; a double-click opens the line in Edit.

- **Discard file** puts the file back as `HEAD` has it (a new file is deleted), after you confirm. File names are taken as names, never as git patterns: discarding `app/[slug]/page.tsx` leaves `app/s/page.tsx` alone.
- **Commit**: check the files to commit (all by default), write a message (several lines are fine), then **Commit** or Ctrl+Enter. Only the checked files are committed, in one commit, however many: they're staged, new and deleted ones too, and anything else you had staged stays staged. (Their names go to git in a temp file in `<git-dir>/wingman/`, removed after; this needs git 2.26 or newer where the repo is.) With several repos in the space, pick the repo above the message box. A warning shows when checked files still have changes to review in Review; it doesn't stop the commit.
- Files with unsaved edits in Edit can't be discarded or committed until those are saved or discarded.
- Up to 500 files are listed; binary files are listed but not shown.
- **Committed on this branch**, under the uncommitted files: every file changed between where the branch split from the remote's default branch (`origin/HEAD`, else `origin/main`, `origin/master`, `main`, `master`) and `HEAD`, as a read-only diff with its line counts. Files an agent of this space changed carry an **AI** mark, here and in the uncommitted list. The list is read again only when `HEAD` or that starting point moves (two git calls per repo), after the uncommitted files show. A file's diff is read when you first pick it ("Loading …" meanwhile); diffs read earlier are let go when they add up to about 4 million characters, or when you leave the space.
- While the Changes tab isn't the panel's shown tab, it does nothing; it looks again as soon as it's shown. Each space keeps its own lists, checked files, picked repo and commit message.


- Review is read-only. Accept and Reject still write to disk. `ctrl-shift-r`, a double-click on a line, and Quick Open of an unchanged file all switch to the Edit tab at that file and line. In the side panel, `ctrl-shift-r` cycles Review → Edit → Changes → Review, handing over the current file each time.
- Edit holds any unsaved edits. Before Review accepts or rejects in a file that has unsaved edits in Edit, those edits are saved (autosave on: try again a moment later), or, with autosave off, you're asked to save or discard them in Edit first.

Wingman finds a space's repos from its terminals' folders and from the files the Claude hook sees agents edit. When it finds none, for example for a WSL agent started from a Windows folder, click **Open folder…** and pick a folder in the repo. The Edit view's file tree has the same button for adding more repos. Added repos are remembered for the space, and capture covers them too.

| Action | Key |
|---|---|
| Accept / reject the selected lines, else the current change | `ctrl-y` / `ctrl-n` (a change's own buttons always act on the whole change) |
| Accept / reject file | `ctrl-shift-enter` / `ctrl-shift-backspace` |
| Next / previous change | `ctrl-down` / `ctrl-up` |
| Next / previous file | `ctrl-shift-down` / `ctrl-shift-up` |
| Undo last accept/reject | `ctrl-z` |
| Next view: Review → Edit → Changes (side panel), Review ↔ Edit (pane) | `ctrl-shift-r` |
| Open the file in your external editor | `ctrl-e` (or the editor's button at the far right), at the cursor or the current change; unsaved edits are saved first. Pick the editor in Settings. |
| File tree (Edit view) | `ctrl-b` |
| Rename / delete the selected file or folder (file tree) | `f2` / `delete`, while the tree has the keyboard (see File operations) |
| Select lines | click a line, or click and drag; Shift+click or `shift-up` / `shift-down` to extend; click inside the selection or `escape` to clear. |
| Menu for a line or change | right-click: Ask agent now, Add review comment, Reject, Reject with comment, Reject and add review comment, Accept (on the selected lines when there are any). Right-click never changes the selection. |
| Ask the agent now about the selected lines, else the current change | `ctrl-m` (or the change's Ask button) |
| Add a review comment on the selection, else the cursor's line, else the current change | `alt-m` (or the change's Comment button, or + Comment in Edit) |
| Review comments: list, jump, edit, delete, send to the agent | `alt-shift-m` (or the header's Comments N) |
| Quick Open | `ctrl-p`: find a file by name across the space's repos (fuzzy, as in VS Code). `name:12` or `name:12:5` opens it at that line; `:12` goes to a line in the current file. With no query it lists recent and changed files. Up and down choose, Tab fills in the chosen path (then add `:line`), Enter opens, Esc closes. |
| Comment on the last rejection | `ctrl-r` (or the header's Comment last rejection) |
| Search in files | `ctrl-shift-f`: the Edit tab's Search, with a one-line selection as the query (see Search) |

## Views

The header switches between two views (`ctrl-shift-r`):

- **Review**: the tabs are the files with changes to review.
- **Edit**: a file tree of the space's repos and plain folders on the left, like VS Code's Explorer (`ctrl-b` shows or hides it, and opens the Edit view from Review). Folders load when you open them. In a repo, the tree comes from git's file list, so empty folders don't show. Ignored files and folders are dimmed, and an ignored folder's content is read from disk when you open it. Each file shows its git status letter (A added or untracked, M modified, D deleted, U conflict), its change count to review and a dot for unsaved edits. Folders show the strongest letter under them and their total count. Deleted files are struck through and still open their diff while under review. A folder lists at most 500 entries and the tree 5000, then "… more files not shown". Click any file to open it in the same editor, with its diff when it has changes. Binary files show "binary file" instead of their content. The tabs are the changed files plus the files you opened. Opened files close with their ×, which saves them when autosave is on. Changed files stay until they're reviewed.

### File operations

Right-click a file, a folder or a root's header (with one root and no header, the tree's empty space) for VS Code's Explorer menu. It works in repos and plain folders, on this computer and on another machine. Entries that don't apply are left out.

- **New File…** and **New Folder…**: a name box opens in the tree, inside the folder (or the root) you clicked, or beside the file. Enter creates, Esc cancels. A name with `/` makes the folders on the way (`a/b/c.ts`). A new file opens in the editor, with the cursor on its one empty line. A new empty folder in a repo shows in the tree though git doesn't list it.
- **Rename…** (`f2`): the name box holds the name, with the part before the extension selected. A name with `/` moves the item, relative to its folder. Changing only letter case (`readme.md` to `README.md`) works on Windows and macOS too.
- **Delete** (`delete`): a confirm under the row names the item, and a repo folder's file count when the repo's file list knows it ("Delete folder src/old and its 12 files?", else "and everything in it?"). Enter or **Delete** deletes, Esc or **Cancel** doesn't. Deleting is permanent, here as on another machine: nothing goes to the trash or Recycle Bin.
- **Copy Path** and **Copy Relative Path**: as the machine names it, with backslashes for a Windows drive.
- **Reveal in File Explorer** (Windows), or **Reveal in file manager** (Finder on macOS, the folder through `xdg-open` on Linux), and **Open in** the external editor: this computer's files only.
- **Refresh** (root header): reads the root's file list and folders again now.

A click on a row (or a root's header) selects it and gives the tree the keyboard, as in VS Code's Explorer:

| Key | While the tree has the keyboard |
|---|---|
| `up` / `down` | the row above or below, across roots (headers included), scrolled into view |
| `right` | opens a closed folder or root, else moves to its first entry |
| `left` | closes an open folder or root, else moves to the folder (or root) above |
| `home` / `end` | the first or last row |
| `enter` | opens a file with the cursor in it (the editor takes the keyboard), or opens or closes a folder |
| `space` | opens a file, keeping the keyboard in the tree |
| `f2` / `delete` | rename / delete the selected row |
| `escape` | closes the delete confirm, else gives the keyboard back to the editor |

Pane shortcuts that don't change the file keep working there (`ctrl-p`, `ctrl-f`, `ctrl-shift-f`, `ctrl-s`, `ctrl-b`, next and previous file or change). Typing, editing keys, undo, accept and reject do nothing: nothing reaches the file while the tree has the keyboard. A click in the editor, a tab or any box gives the keyboard back, so `delete` in a file still deletes text. `f2` and `delete` can be changed in Settings → Keyboard shortcuts.

Names that are refused, with the reason shown under the box (the box stays open): empty, `.` or `..`, `.git`, a backslash, a NUL, a leading `/`, a file name ending in `/`, anything already there. Folders on a Windows drive also refuse `< > : " | ? *`, a name ending in a dot or a space, and names Windows reserves (`CON`, `NUL`, `COM1`…). Every operation stays inside its root: never the root itself, never `.git` or anything in it, never a path with `..`. A root that is no project, only where a terminal happens to be (`/`, a drive or share root, `/mnt/c`, `/home`, `C:\Users`, a system folder such as `/usr` or `C:\Windows`), gets no file operations at all: "File operations aren't available in /: open a project folder".

Files with unsaved edits, in this tab or another Wingman tab, block renaming or deleting them and any folder holding them, naming the files. A renamed file that was open reopens at its new path; a deleted one's tab closes. Review sees a rename as git does, the old path deleted and the new one added: a renamed file under review shows there as deleted. Afterwards the tree reads the changed folders and the repo's file list again at once, open folders stay open, and the new or renamed item is shown.

How it runs: on Linux, macOS and another machine, one `sh` script with the paths as arguments (`mv` for rename, `rm -rf` for a folder, which refuses anything outside its root, anything under a root such as `/` or `/mnt/c`, `/`, and a home folder or a folder above one). On a Windows drive, PowerShell with each path as a quoted literal and .NET calls (`File.Move` and `Directory.Move`, which never replace a target; a folder's delete walks it, clears read-only attributes and removes junctions as links). In WSL's own files, the `sh` script through `wsl.exe`. A Windows machine elsewhere says "Saving on a Windows machine isn't supported yet". Each operation is one call: about 0.8 s on a Windows drive, 0.3 s in WSL's files, 0.15 s on another machine.

## Editing

The diff is also an editor. Click in the text to place the cursor and type. Your own edits to unchanged lines are kept as accepted, so they never show up for review. Edits inside the agent's added lines stay part of its pending change. Removed lines are read-only. `ctrl-s` saves, and a dot on the tab marks unsaved edits. With autosave on (the default), edits are saved when Wingman loses focus, when you switch files, spaces or views, and when you close a tab. If the agent writes to a file while you have unsaved edits, its changes are merged into yours. Where you both changed the same lines, the agent's lines win with autosave on. With autosave off, a banner offers Keep mine or Take agent's, and the rest of both edits is kept either way. A merge clears undo for that file. If the agent deletes the file, the banner offers Keep mine or Drop my edits.

| Action | Key |
|---|---|
| Move | arrows, `ctrl-left` / `ctrl-right` by word, `home` / `end`, `pageup` / `pagedown`, `ctrl-home` / `ctrl-end` |
| Select text | Shift with any move, drag, double-click a word, triple-click a line, `ctrl-a` |
| Edit | type, `backspace` / `delete` (with `ctrl` by word), `enter` keeps the indent, `tab` / `shift-tab` indent and outdent |
| Copy, cut, paste | `ctrl-c` / `ctrl-x` / `ctrl-v` (without a selection: the whole line) |
| Brackets and quotes | typing `(` `[` `{` `"` `'` `` ` `` adds the closer (before whitespace, a line end or a closer; quotes not right after a letter). Typing the closer steps over it, Backspace in an empty pair removes both, Enter between brackets opens an indented line, and with text selected it wraps the selection. |
| Tags | in HTML, XML, SVG, Vue, Svelte, JSX and TSX files, typing `>` at the end of an opening tag adds its closing tag after the cursor (not for HTML void elements such as `<br>`, self-closing tags, or a generic like `Foo<T>`), and typing `/` right after `<` completes the innermost open tag. Enter between `<p>` and `</p>` opens an indented line. |
| Line wrap | `alt-z` or Settings → Wrap long lines (off by default). Long lines continue on the next screen row, broken after a space when there is one, with continuation rows indented like the line. Up and Down move by screen row; sideways scrolling is off while wrapped. |
| Move lines up / down | `alt-up` / `alt-down` (Herdr's agent keys by default, see below) |
| Copy lines up / down | `alt-shift-up` / `alt-shift-down` |
| Delete lines | `ctrl-shift-k` (Herdr's picker key by default, see below) |
| Join lines | `ctrl-j` (with the next line, or all selected lines) |
| Toggle comment | `ctrl-/` (line comments by file type; block comments for HTML, XML, Vue, Markdown and CSS) |
| Find | `ctrl-f` (a one-line selection becomes the query). Enter / Shift+Enter or `f3` / `shift-f3` for the next and previous match. `alt-c` case, `alt-w` whole word, `alt-r` regular expression. Esc closes. |
| Replace | `ctrl-h`. Enter replaces the current match and moves on; `ctrl-enter` in the replace box, `ctrl-alt-enter` or All replaces every match as one undo step. With regular expressions, `$1` and the like insert groups. |
| Go to line | `ctrl-g`, then a line or `line:column` |
| Bracket matching | with the cursor next to `(` `)` `[` `]` `{` `}`, both brackets of the pair get a box. Brackets in strings and comments don't count. None while text is selected. |
| Save | `ctrl-s` |
| Undo / redo | `ctrl-z` / `ctrl-shift-y` (one history with accept and reject; redo is for edits). Each space keeps the newest 200 steps, fewer when they hold over about 24 MB of file text; older steps are dropped. |
| Scroll sideways | Shift+wheel |

Line operations act on the cursor's line or every line a text selection covers, and each is one undo step. Herdr's global keys reach Herdr before Wingman, so `alt-up`, `alt-down` and `ctrl-shift-k` need a `mod:wingman` section in `keys.json` to send them to Wingman while it has focus:

```json
"mod:wingman": {
  "alt-up": "wingman.moveLineUp",
  "alt-down": "wingman.moveLineDown",
  "ctrl-shift-k": "wingman.deleteLine"
}
```

A key sent this way acts only where the same key pressed in Wingman would: never on the file while a box has the keyboard (find, Quick Open, Search, the commit message, a tree name box) or while the tree has it. Every line operation is also a command for other keys: `wingman.moveLineUp`, `wingman.moveLineDown`, `wingman.copyLineUp`, `wingman.copyLineDown`, `wingman.deleteLine`, `wingman.joinLines` and `wingman.toggleComment`.

Comment, Accept and Reject act on the lines a text selection covers. Clicking the line numbers still selects whole lines. Not supported: input methods that compose characters (Chinese, Japanese, Korean), and wide characters or emoji, which put the cursor in the wrong column.

## Search

`ctrl-shift-f` (or **Search** at the top of the Edit tab's left column, beside **Explorer**) searches the files of every git repo in the space, on another machine too, as `git grep` sees them: tracked and untracked files, not ignored or binary ones. Plain folders aren't searched. From Review or Changes it switches to the Edit tab. A one-line text selection becomes the query.

- Typing searches once you pause (from 2 characters), and Enter searches at once. `alt-c`, `alt-w` and `alt-r` (or **Aa**, **W**, **.\***) toggle match case, whole word and regular expression. Esc gives the keyboard back to the editor and keeps Search open.
- ▸ beside the box shows **Replace**, **files to include** and **files to exclude**: globs separated by commas, such as `src/**, *.ts`. A glob without a `/` matches at any depth, and a folder matches everything in it.
- Regular expressions are the subset that git and JavaScript read alike: classes, groups, alternation, quantifiers, anchors, `\b`, `\d \w \s` and their capitals. Lookarounds, lazy quantifiers, backreferences in the query and searches across lines are refused with a message.
- Results are grouped by file (with the repo first when the space has several), at most 2,000. Click a file to fold it. Click a match, or Down from the box, then Up/Down and Enter, to open the file at that match with it selected. Left and Right fold and unfold. While the results have the keyboard, typing doesn't reach the editor: Enter, Esc or a click in the editor gives it back.
- With text in **Replace**, each match shows its replacement (`$1`, `$&` and the like insert groups in regex mode) and **Replace All** appears. It asks first ("Replace 12 occurrences in 4 files?"), then rewrites only the lines the results list, from each file as it is on disk then. A file under review is changed the way a saved edit of yours is: on unchanged lines the review baseline takes the same edit, inside the agent's added lines the change stays pending, and the agent gets the edit note. Each write is compare-and-swap: a file changed since it was read is skipped and named. Files with unsaved edits in any Wingman tab block it until they're saved or discarded. Afterwards open files reload and the search runs again. Replace All is not undoable from Wingman.
- Each space keeps its own query, options, results and which mode the left column shows.

## Neovim as the editor

Set **Editor** to **Neovim** in Settings to edit in Neovim instead of Wingman's own editor. Wingman stays the review: clicking a line of the diff, `ctrl-o`, the **Neovim** button, or a file in the tree opens that file at that line in a Neovim pane beside Wingman. In the Edit view, Wingman then shows only the file tree, full width, and a click opens the file in Neovim at its first change. Each space gets one Neovim, started with `--listen`, and later files open in the same one. Buffers reload when the agent writes to a file, unless they hold unsaved edits. Wingman picks up Neovim's saves within 2 seconds.

On Windows, Wingman uses `nvim.exe` when it's on PATH, otherwise WSL's `nvim`. Your own Neovim config applies, including its plugins for autopairs, tags and line moves. Herdr's global keys (for example `alt-up` / `alt-down`) still apply inside the Neovim pane unless `keys.json` sends them to the terminal.

## Keyboard shortcuts

Every key in the tables above can be changed in **Settings → Keyboard shortcuts…**. Click **+ key** on an action and press the new shortcut. An action can have several keys, × removes one, and **Reset** puts an action back to its defaults (**Reset all** does every action). If the key belongs to another Wingman action, you're asked whether to move it. Plain typing keys and the keys for moving and deleting text (arrows, Home/End, Page Up/Down, Backspace, Delete, Enter, Tab) can't be rebound.

Herdr's global shortcuts reach Herdr before Wingman. When a Wingman key is one of them (by default `alt-up`, `alt-down` and `ctrl-shift-k`), Wingman adds it to the `mod:wingman` section of Herdr's `keys.json`. Herdr then sends it to Wingman while Wingman has focus, and the shortcuts page shows which Herdr action it hides there. Wingman only changes its own entries in that section (`wingman.<action>`).

Your changes are saved in `~/.config/herdr-app/data/wingman/keys.json` as `{ "<action>": ["key", ...] }`, holding only the actions you changed. Each action is also a command, `wingman.<action>` (for example `wingman.joinLines`), that you can bind anywhere in Herdr's `keys.json`.

## Settings

The header's **⚙ Settings** opens:

- **Auto note on rejections**: tell the agent which of its changes you rejected. On by default.
- **Note on my edits**: when you save, tell the agent that changed the file which lines you edited, so it reads the file again before its next change. On by default. The note is delivered with the agent's next tool call or prompt, and a newer save replaces a note it hasn't read yet.
- **Auto-close brackets and quotes**: the bracket and quote rules under Editing. On by default.
- **Auto-close tags**: the tag rules under Editing. On by default.
- **External editor**: VS Code (default), Cursor, Windsurf, Zed, Sublime Text, or a custom command with `{path}`, `{line}` and `{col}`. VS Code, Cursor and Windsurf open WSL files through Remote - WSL. On Windows a `.cmd` launcher runs through cmd.exe, which refuses paths containing `& | < > ^ % ! " , ; =`.
- **Editor**: Wingman (the built-in editor, the default) or Neovim (see Neovim as the editor).
- **Autosave**: save when Wingman loses focus (another pane, or another window), and when you switch files or spaces. On by default. Herdr has no blur event for mods, so focus is checked 4 times a second.
- **Also save after typing stops for**: Focus change (no timer, save on focus change only), 1, 2, 3, 5 or 10 seconds. Focus change by default.
- **Claude hook on <machine>** (a space on another machine only): its status, and Install and Remove (see Install).

Settings are kept in `~/.config/herdr-app/data/wingman/settings.json`.

## Files it writes

| Where | What |
|---|---|
| `<git-dir>/wingman/` | `index.json`, `baselines/`, `capture.json`, `sums.json` (what each reviewed file had while it differed from `HEAD`), `snap.<pid>.index` while a snapshot runs (per repo) |
| `~/.config/herdr-app/data/wingman/` | `events/` (from the hook, removed once read), `feedback/` (notes for Claude), `outbox/` (comments waiting for an idle agent), `spaces.json` (repos agents used, per space), `hidden.json` (repos removed by hand, per space), `workspaces/` (workspace files Wingman made), `settings.json` |
| the space's folder | `<folder>.code-workspace`, when you add a second repo and the folder isn't inside a repo |
| `~/.config/herdr-app/data/wingman-leader.json`, `wingman-capture.log` | which pane copy runs capture, and its log |
| another machine's `~/.config/herdr-app/data/wingman/` | with the Claude hook installed there: `wingman-hook.sh`, `wingman-install.json`, `events/` (removed once read), `feedback/` |
