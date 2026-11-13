# private-app

Runs a private Herdr app instance for testing mods. It has its own app home and its own herdr-core session, and shares nothing with the Herdr you are using. Its window shows up on screen beside yours.

Only WSL driving the Windows app is implemented. The platform-specific parts are the `plat_*` / `wsl_*` functions in `private-app`. On any other platform the script exits with "not supported yet".

## Commands

```sh
P=tools/private-app/private-app
n=$($P start --mod path/to/mods/my-mod)      # prints the instance name (or --name N)
$P status "$n"                               # app alive, core alive, layout, errors
$P app "$n" check 'C:\...\home\mods\my-mod'  # any herdr-app command: status, ls, do, check
$P app "$n" do space.new '{"name":"t"}'
$P hc "$n" ls --json                         # any hc command, in the instance's session
$P wait "$n" 15 app status                   # poll until it succeeds (also: hc, shot, status, alive, a program)
$P shot "$n" [file.png]                      # prints the PNG's WSL path
$P alive "$n"                                # exit 0 while the private app process exists
$P crashinfo "$n"                            # Application Error events for this app's pid, then app.log's tail
$P procs "$n"                                # the instance's processes now
$P env "$n"                                  # export lines for ad-hoc use
$P list
$P stop "$n" [--keep-home]   |   $P stop --all
```

`start` options:

- `--name N`: matches `^[a-z0-9][a-z0-9-]{0,30}$`. The default is `i<MMDD-HHMMSS>-<random>`.
- `--mod DIR`: repeatable. The folder is copied to `<home>/mods/<basename>`.
- `--layout FILE.json`: installed and shown.
- `--keep-home`: `stop` keeps the files.

`start` returns once `status` answers, in about 13 s.

## Where an instance lives

- `%TEMP%\herdr-private\<name>\` holds `instance.json` (session, paths, pids with creation times, start time), `app.log` (the app's stdout and stderr) and `home\` (`HERDR_APP_HOME`).
- Core session `pa-<name>`. The core keeps its state in `%LOCALAPPDATA%\herdr-core\pa-<name>\`.
- The selftest writes screenshots to `%TEMP%\herdr-private\selftest-shots\`.

## Safety rules (enforced in code)

1. Every instance command refuses to run when:
   - the session is empty, `default`, or not `pa-<name>`;
   - the home is empty, is not `herdr-private/<name>/home`, or is or contains `%USERPROFILE%\.config\herdr-app`.
2. Inherited `HC_*`/`HERDR_*` variables are removed before the instance's own are set. Windows also hands its own variables to every program started from WSL, whatever WSL's environment says. On this machine that includes `HERDR_WINGMAN_DIR`, which points at the real Wingman data folder. `start` lists those names. Every call blanks them through `WSLENV` (an empty value removes the variable on the Windows side). The core is started through PowerShell, which first removes every `HC_*`/`HERDR_*` variable that is not the instance's.
3. A process is ended only after it is re-checked in the same PowerShell call: the recorded pid, the name, and the creation time to the 100 ns tick. Holders are also checked against their command line. There are no name-wide kills.
   - Holders are found by the pipe name `herdr-core-<user>-pa-<name>.`, with a trailing dot so `pa-x` never matches `pa-x2`.
   - The instance's other processes are the recorded ones plus their descendants (by parent pid, created after the parent).
4. `herdr-app.exe` and `hc.exe` only run with the instance environment. The tool never queries your app. The app version comes from the exe's file properties.
5. `HERDR_RELEASES_URL=http://127.0.0.1:9`, `HERDR_TELEMETRY=0`, `DO_NOT_TRACK=1` and `HERDR_APP_NO_SOUND=1` are always set. Nothing updates itself and nothing is sent.
6. Names are validated, paths are quoted, and nothing from the user is evaluated. PowerShell scripts only receive validated digits, names and checked paths.

## How it works

- **Launch.** The app is launched detached from WSL (`setsid env ... herdr-app.exe > app.log`). Its Windows pid is the one `herdr-app.exe` of that exe path that did not exist before the start (the pre-start list is recorded) and was created after it. Two or more candidates make `start` fail rather than guess.
  - A `Start-Process` launch from PowerShell does not work here. It does not return while the app runs, because the app inherits the WSL interop's stdio handles. This happens even with PowerShell's output sent to /dev/null (checked with `ping -n 6`).
- **Mods are copied before the first start.**
  - Tested by experiment on 0.1.15: a mod copied before the first start and one copied while the app ran were both listed in `seen.json`, left byte-identical, passed `check`, and rendered as panes.
  - Copying first means the app sees the mod at its first start. `start` then diffs each copy against its source (ignoring `jsconfig.json` and `*.d.ts`) and fails if the app changed it.
  - A mod with the same name as a shipped one would be moved to `<name>-edited` on start. The diff catches that.
- **Layout.** The file is copied to `home/layouts/` and `shared.json` is seeded with `"layout": "<name>"` before the first start. This was verified: the layout was shown at the first start and `status` reported it. If it is not shown, `start` falls back to `do layout.switch`.
- **Home seeding.** `shared.json` gets `{"frame.welcomed": true}` (no welcome screen). `update-notes.json` gets `{"last_run": "<app version>", "presented": []}` (no "Updated" toast). The app writes the rest.
- **stop** works in this order:
  1. End the app. If no pid was recorded because `start` failed, it uses the same "new since start, exactly one" rule.
  2. `hc kill` each core terminal and run `hc server stop`. These run only while the recorded core is alive, because other hc calls would start a new core.
  3. End any holder left for the session.
  4. End any remaining descendant from the pre-stop snapshot, re-verified.
  5. Delete the home and the core state folder, retrying while files are locked.

## Self-test

`tools/private-app/selftest.sh [--ref REV]` does the following:

- Records your `herdr-app.exe` and `herdr-core.exe` processes.
- Runs an instance with no mod: start, status without errors, screenshot, stop, nothing left.
- Runs an instance with Wingman from `git archive REV` (default `HEAD`, never the working tree): start, status without errors, `check` passes, opens Wingman in a tab, status without errors, screenshot, no crash events, stop, nothing left.
- After each instance, checks that your recorded processes are all still alive. It reports a missing one and never restarts anything.
- Stops its instances on failure (trap).

"Nothing left" means: none of the instance's processes (by pid and creation time), no holders of its session, no home and no core state folder.

## Verified and not verified

Verified on Windows 11 with WSL2, app 0.1.15 and core 0.1.21, beside a running Herdr:

- The selftest passed on three runs (the first after one fix to its own crash check) and left your Herdr processes alive.
- `--layout`, the stop fallback without a recorded app pid, a core terminal (`space.new`) cleaned up by `stop`, `wait`, `env`, `list` and `crashinfo`.

Not verified:

- `stop --all` with several instances.
- `--keep-home` on `start`, which is only recorded and honoured by `stop`.
- Native Linux and macOS, which are not implemented.

## Known limits

- The private window is visible on screen. `shot` captures the app's own frames, so it works even when the window is covered.
- `crashinfo` matches Application Error 1000 events to the app's pid. WER 1001 events name no pid and are left out.
- One Wingman run in an early version of this tool coincided with a crash of the person's own Herdr (13:44:23). Later runs with Wingman did not repeat it. Treat runs with Wingman loaded as the riskier case.
- `start` blanks the inherited Windows variables it finds, but it only knows the `HC_*`/`HERDR_*` names. A mod that reads other variables from the Windows environment still sees the real values.
