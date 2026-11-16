# Dockr

Status: needs-triage

A Herdr mod that shows Docker containers in a side panel and sets which Source each Service of a Stack runs from. Terms in capitals are defined in `CONTEXT.md`. The decision to keep path variables out of `.env` is in ADR 0001, "Dockr never reads the Stack's `.env`", kept in the author's own notes.

## Problem

Work on the product happens in git worktrees, several at a time, each driven by an agent in its own Herdr space. One local Docker stack (`shop-local`) serves all of them. Today, finding out which checkout a container runs from means `docker inspect`, and changing it means setting a variable by hand and running compose. the project's own start script sets the variable for one run only, so a later `up` returns the service to the Main checkout without saying so.

## Environment this was designed against

- One compose project, `shop-local`, defined in `deploy/docker-compose.local.yml`.
- Four Services pick their checkout from a variable: `gateway` (`API_PATH`), `web-client` (`WEB_PATH`), `admin-client` (`ADMIN_PATH`), `billing` (`BILLING_PATH`). The variable sets the build context and, for the first three, the `src` bind mount. `billing` has no bind mount.
- Only `src` is mounted. Dependencies and every file outside `src` are baked into the image.
- Host ports are fixed, so one copy of the stack runs at a time.
- Herdr runs on Windows. The `wsl` Machine is the same computer's WSL. Docker Desktop uses the WSL 2 backend, so `docker` from Windows and from WSL reach one engine.
- Worktrees of one ticket share a branch name across Repos. Some worktrees live under the WSL home and are not reachable from Windows paths.
- No Main checkout is reliably on `main`.

## Scope

In:

- A docked right-side panel listing containers, grouped by Stack.
- Switch, for one Service or for several that share a branch.
- Start, stop, restart, rebuild, stack up, stack down, shell, log tail, open served URL.
- Toasts for Service events while the panel is hidden.

Out:

- Creating or removing worktrees. Wranglr owns that.
- Managing named volumes. `down -v` is never run.
- Running more than one copy of a Stack.
- Switches triggered by agents or by focus changes.
- CPU and memory figures.
- Keyboard navigation inside the panel.

## The panel

- Mod name `dockr`, share folder `dockr/`.
- Its own block, id `dockr`, at the right end of the `workbench` layout's work area, beside the Files and Changes panel. `ctrl-shift-d` runs `layout.toggle:dockr`, and the palette lists it. It is not a child of the existing panel stack, because `tabs-plus` owns that stack and hides children it does not know.
- One collapsible group per configured Stack, in config order. A last group, "Other containers", holds every container outside a configured Stack. It is collapsed by default and has no Source controls.
- One warning line at the top when a config file has problems, with details on hover.
- A Reload button in the header.

Each Service row shows:

- State: running, exited (with exit code), restarting, created.
- Health, when the container defines a healthcheck.
- Source: the branch of the checkout the container really mounts or was built from. For the Main checkout the row shows its current branch and marks it as the Main checkout.
- A Drift marker when the real Source differs from the one the Stack is set to, with an Apply button.
- Published ports.
- Served URLs (see below).

A stopped Service shows the Source it will start from.

## Sources

- A Service offers its Repo's Main checkout and every worktree of that Repo, each labelled by branch.
- When `wranglr.json` exists, Dockr takes Repo identities, Main checkout paths per Machine and the worktree location pattern from it. Otherwise it uses the Main checkout path in `dockr.json` and `git worktree list` run there.
- Git runs on the Stack's Machine, so paths are in that Machine's format.

## Switch

1. The user opens a Service's `Source` list, picks a checkout, sets "Start if stopped" and presses Switch.
2. Dockr writes the Service's path variable to `.dockr.env` beside the compose file. Choosing the Main checkout removes the line.
3. If the Service is running, or "Start if stopped" is ticked, Dockr brings it up. Otherwise nothing else happens.
4. Bringing it up rebuilds the image only when needed (next section). Otherwise the container is recreated with the new mount.

Every compose command Dockr runs passes `--env-file .env --env-file .dockr.env`. Dockr never opens `.env`.

### When a Switch rebuilds

- A Service with no bind mount rebuilds on every Switch.
- Otherwise Dockr compares the dependency manifests of the target Source with those the current image was built from. If any differ, it rebuilds.
  - Node: `package.json` and the lockfile.
  - C#: the project files and NuGet config files, listed in the config.
- The manifest list per Service comes from the config, as paths with no wildcards. The default is the Node pair.
- Rebuild is always available as its own action, which covers files outside `src` that Dockr does not compare.

## Moving several Services at once

There is no Stack-wide switch. Most branches have a worktree in one Repo only, and a Stack-wide switch would send every other Service back to its Main checkout, which breaks the mixed setups that are the normal state.

When the checkout picked for one Service is a worktree, the picker lists every other Service whose Repo has a worktree on the same branch, as "also <service>", ticked by default. The ticked ones move in the same Switch, with one compose command. Services not named keep their Source.

## Drift

The Source a row shows comes from the container (its bind mount, else its image's build context label). When that differs from `.dockr.env`, the row is in Drift. Apply brings the Service up from the Source in `.dockr.env`. Commands run by hand, including the project's own start script, are the expected cause.

## Other actions

| Action | Scope | Notes |
|---|---|---|
| Start, stop, restart | Service | |
| Rebuild | Service | Current Source, `up --build -d` |
| Up | Stack | |
| Down | Stack | Asks first. Never `-v` |
| Shell | Service | `docker exec -it <container> sh` |
| Log tail | Service | `docker compose logs -f --tail 200 <service>`. The button toggles it |
| Open URL | Service | System browser |

Stack down is the only action that asks for confirmation.

### Terminals

Shell, log tail and every build or bring-up run as headless `hc` terminals on the Stack's Machine, labelled so Dockr finds them again. They open as a peek and keep running when the peek closes, as the `run` mod's processes do. A row shows when its log tail or build is live. One log terminal per Service is reused. A build terminal closes itself on success and stays on failure.

## Served URLs

- Each configured URL shows as a chip under the Service that serves it: the one its config entry names, else the one publishing its `localhost` port. A URL with neither shows under the Stack's name.
- `https://<name>` for every hosts-file name that maps to 127.0.0.1 and is not in the config, under the Service that publishes 443.
- In a row's details: each published port, opening `http://localhost:<port>` (`https` for 443).

## Alerts

While the panel is hidden, Dockr posts one toast per event for Services of configured Stacks:

- started (healthy when the container has a healthcheck, else running),
- exited with a nonzero code,
- turned unhealthy.

Clicking a toast shows the panel.

## How Dockr learns of changes

No timers.

- Config files (`dockr.json`, `wranglr.json`): read at start, when the panel is shown, before every action, and on Reload.
- Container state: Dockr waits on `docker events` filtered to containers and returns at the first event. It then reads `docker ps` and `docker inspect` once and waits again from that event's timestamp. Mod `exec` is capped at 10 minutes, so the wait restarts at that interval. Dockr also reads state after each of its own actions.
- Sources: read when the panel is shown, when a Source picker opens, and before a Switch.

## Config file

`~/.config/herdr-app/dockr.json`. With no file, Dockr shows every container read-only.

```json
{
  "stacks": [
    {
      "name": "shop-local",
      "machine": "wsl",
      "compose": "/mnt/c/dev/shop/deploy/docker-compose.local.yml",
      "services": {
        "gateway": { "var": "API_PATH", "repo": "dev.azure.com/Org/Proj/api-server", "main": "/mnt/c/dev/shop/api-server" },
        "web-client": { "var": "WEB_PATH", "repo": "dev.azure.com/Org/Proj/web-client", "main": "/mnt/c/dev/shop/web-client" },
        "admin-client": { "var": "ADMIN_PATH", "repo": "dev.azure.com/Org/Proj/admin-client", "main": "/mnt/c/dev/shop/admin-client" },
        "billing": { "var": "BILLING_PATH", "repo": "dev.azure.com/Org/Proj/billing", "main": "/mnt/c/dev/shop/billing", "manifests": ["Billing.API/Billing.API.csproj"] }
      },
      "urls": {
        "https://app.example.test": { "label": "Review UI", "service": "web-client" },
        "https://admin.example.test": { "label": "Admin UI", "service": "admin-client" },
        "http://localhost:3010/api/health": "Gateway health"
      }
    }
  ]
}
```

- `machine`: the Machine Docker and git commands run on. `""` is this computer.
- `services.<name>.var`: the compose variable that sets the Service's checkout.
- `services.<name>.repo`: the Repo identity, as Wranglr writes it. Used to look the Repo up in `wranglr.json`.
- `services.<name>.main`: the Main checkout path on that Machine. Optional when Wranglr knows it.
- `services.<name>.manifests`: overrides the default dependency manifests.
- Stack specifics live only here. The mod's code names no Stack, Service or variable.

## How it is built

- Worktree `.worktrees/dockr`, branch `dockr`.
- The decisions (which Services can move together, whether a Switch rebuilds, whether a row is in Drift, which toast an event earns) live in a pure module with tests, run without Herdr.
- The mod is copied to `~/.config/herdr-app/mods/dockr/` to run, leaf modules first and `main.js` last.
- `herdr-app check` passes before any version is called done.

## Redesign: actions on the row, Source through a picker

This replaces the row details, buttons and build view described above. Decided after the first build was in use.

- **Actions on the row.** Hovering a row shows icons for Stop or Start, Restart, Rebuild, Logs and Shell. Opening a row shows only image, state, paths and ports.
- **Status.** A solid dot is up, a turning ring is starting or being worked on, red is unhealthy or exited with an error, hollow is stopped. State text shows only when it is not plain "up".
- **Program icon.** Each row shows Herdr's shipped icon for its program, chosen from the image and command.
- **Stack header.** One segment per Service colored by status, `Up` only while something is not running, and a power icon for Down.
- **Source picker.** Clicking a row's branch opens a popup at the pointer for that Service: a filter box, its checkouts, the "also move" checkboxes, "Start if stopped", Rebuild and Switch. Arrow keys move and Enter switches. The popup hands its request to the panel through shared state, because a popup's own work ends when it closes.
- **Cost before the click.** When the picker opens, Dockr compares each checkout's manifests with the image's and marks it `current`, `recreate` or `rebuild`.
- **Progress in the row.** A Switch no longer opens the build view. The row shows `checking`, then `building` or `recreating`, then `waiting for healthy`. The phase comes from the build terminal's labels and the container's creation time, both of which arrive without polling.
- **Failure.** A failing script labels its own terminal `dockr.failed=<code>` and waits. The row shows a red chip that opens the output, and one toast is posted. Dismissing the output clears it.
- **Undo.** After a Switch, the note line offers "Back to <branch>" until the next action.
- **Suggestion.** When the focused pane's branch has a worktree in a Service's Repo and the Service is set elsewhere, the row shows "Use <ticket>?". It switches only on click.
- **No false Drift.** A Stack with no `.dockr.env` takes what runs as its record. The first write also records every Service already on a worktree.
- **Errors.** Docker not running, a port in use, a missing compose file, an unknown service and an unreachable Machine each get a sentence saying what to do.
- **Structure.** `model.js` decides, `docker.js` runs programs, `store.js` holds state and prepares each action, `main.js` draws. `tests/stack.test.mjs` runs every action against a throwaway compose project.

## Known limits

- Differences in files outside `src` other than dependency manifests are not detected. Use Rebuild.
- `.dockr.env` must stay out of git in `common`.
- The first bring-up from the `wsl` Machine recreates containers that were created from Windows paths.
- Toasts start once the panel has been shown for the first time, and stop if the block is removed from the layout.

## Resolved during implementation

- Manifests of the current image are read from the image itself (`docker run --rm --entrypoint sh <image>`), hashed, and compared with the same hash of the target checkout.
- Docker records no build context, so a Service with no bind mount shows its Source only after Dockr builds it. Dockr remembers the image id and the Source of each such build.
- On Docker Desktop a bind made from WSL has an opaque mount path. The real path is in a `desktop.docker.io/binds/<n>/Source` label that only `docker ps` prints, so Dockr reads it from there.
- A Stack's Machine needs `sh` and `bash`. Windows itself is not supported as a Stack's Machine.
