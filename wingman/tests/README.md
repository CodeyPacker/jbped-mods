# Wingman mod tests

Run all: `sh wingman/tests/run.sh`. Run some: `sh wingman/tests/run.sh git changes`. Needs Node 22+ and git.

`run.sh` builds a temp app home (`WINGMAN_TEST_HOME`, with `mods/wingman` symlinked to the repo and an empty `data/wingman`) and removes it afterward.

`herdr-shim.mjs` stands in for the `"herdr"` module (exec, file IO, `appHome()`). `register.mjs` and `hooks.mjs` map the import to it. Like Herdr, its local `readTextFile` rejects a file over 1 MiB. Every `exec` is recorded in `execCalls`, and a test can answer calls itself with `fake.exec` / `fake.read` (return undefined to fall through), for example a call that never settles (`routes.test.mjs`).

`main.js` imports UI modules and is not covered.

To add a test: create `<name>.test.mjs`, import `../mods/wingman/<file>.js`, use `node:assert`, throw on failure, and keep temp repos in your own `mkdtemp` dirs.

`herdr-shim.mjs` runs `on` (another machine) calls here and records them in `remoteCalls`. With `WINGMAN_REMOTE_HC` set to `hc`'s path, machine `WINGMAN_REMOTE_ON` (default `wsl`) is reached for real through `hc exec --on` and `hc file read --on`.

`remote/wsl.test.mjs` runs Store, Changes and tree calls, fsx writes (byte exactness, chunked 200 KB and 1.5 MB files, compare-and-swap, mode and links), the Explorer's file operations (create, rename, move, delete, confinement) and a review round trip (snapshot, adopt, accept, reject, undo, reconcile) against a real machine, printing timings, in a repo it makes under `/tmp/wingman-remote-*` there and deletes. It isn't in the default set: `sh wingman/tests/run.sh remote/wsl`. It finds `hc.exe` or `hc` on PATH (or `WINGMAN_REMOTE_HC`), and passes with a printed reason when hc or the machine is missing.

`windows/` holds tests for Windows Node (PowerShell and `wsl.exe` routes), not in the default set. From the tests folder in cmd: `set "WINGMAN_TEST_HOME=%TEMP%"&& node --import ./register.mjs windows/fileops.test.mjs` (and `windows/fsx.test.mjs`).

`snapshothard.test.mjs` runs the snapshot hardening cases (line endings, submodules, nested repos, filters, sparse checkout, merges/rebases in progress, hooks, odd paths, unreadable files, concurrency, repo shapes, noisy stderr) against `snapshot.sh`. The cases live in `snapcases.mjs`, the temp-repo and "repo untouched" helpers in `snaphelper.mjs`. `WINGMAN_SNAP_CASES=C6,C9` runs only some. `windows/snapshothard.test.mjs` runs the same cases against `snapshot.ps1` (command as for the other `windows/` tests, about 10 minutes, symlink cases skip without the privilege). The timing cases (20,000 files, one 200 MB file) are opt-in: `sh wingman/tests/run.sh slow/snapshotsize` (ext4 and the Windows temp folder through `/mnt/c`) and `windows/snapshotsize.test.mjs` (ps1).
