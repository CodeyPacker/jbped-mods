# herdr-mods

Mods and layouts for the Herdr desktop app. Each top-level folder is one share.

## Language

### Wranglr

**Wranglr**:
The mod that draws the spaces list in the sidebar, sorted into Groups, and keeps the Workspaces.

**Space**:
Herdr's place to work on one Machine, holding tabs and panes.
_Avoid_: session, window

**Machine**:
A host that Herdr runs spaces on: this computer, WSL, or an ssh remote. A space belongs to exactly one Machine.
_Avoid_: host, server, remote

**Repo**:
A git repository, identified by its normalised remote URL, or by the basename of its root when it has no remote. Clones and worktrees of it on any Machine are the same Repo.
_Avoid_: project, checkout

**Workspace**:
A curated, named list of Repos that tasks commonly need together. It exists with no spaces open and covers every Machine.
_Avoid_: project, profile, multi-root

**Workspace home**:
The directory on one Machine that a Workspace's spaces start in, and where files that belong to the Workspace as a whole are kept.
_Avoid_: root, base directory

**Group**:
A container of spaces in the sidebar. It is one of three kinds: Workspace group, Repo group, or Custom group.
_Avoid_: folder, directory, section

**Workspace group**:
The Group that holds the spaces of one Workspace.

**Repo group**:
The Group that holds the spaces working in one Repo alone. It exists whether or not that Repo is also in a Workspace.

**Custom group**:
A Group the user makes and names, filled only by hand.
_Avoid_: space folder, manual folder

**Subgroup**:
A named division inside a Group, filled only by hand. A Subgroup holds spaces and nothing else.
_Avoid_: subfolder, subdirectory

**Loose space**:
A space in no Group. Loose spaces sit below every Group.
_Avoid_: ungrouped, orphan
