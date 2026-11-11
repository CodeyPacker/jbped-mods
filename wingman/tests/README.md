# Wingman mod tests

Run all: `sh wingman/tests/run.sh`. Run some: `sh wingman/tests/run.sh git changes`. Needs Node 22+ and git.

`run.sh` builds a temp app home (`WINGMAN_TEST_HOME`, with `mods/wingman` symlinked to the repo and an empty `data/wingman`) and removes it afterward.

`herdr-shim.mjs` stands in for the `"herdr"` module (exec, file IO, `appHome()`). `register.mjs` and `hooks.mjs` map the import to it.

`main.js` imports UI modules and is not covered.

To add a test: create `<name>.test.mjs`, import `../mods/wingman/<file>.js`, use `node:assert`, throw on failure, and keep temp repos in your own `mkdtemp` dirs.

`herdr-shim.mjs` runs `on` (another machine) calls here and records them in `remoteCalls`. With `WINGMAN_REMOTE_HC` set to `hc`'s path, machine `WINGMAN_REMOTE_ON` (default `wsl`) is reached for real through `hc exec --on` and `hc file read --on`.

`remote/wsl.test.mjs` runs Store, Changes and tree calls, fsx writes (byte exactness, chunked 200 KB and 1.5 MB files, compare-and-swap, mode and links) and a review round trip (snapshot, adopt, accept, reject, undo, reconcile) against a real machine, printing timings, in a repo it makes under `/tmp/wingman-remote-*` there and deletes. It isn't in the default set: `sh wingman/tests/run.sh remote/wsl`. It finds `hc.exe` or `hc` on PATH (or `WINGMAN_REMOTE_HC`), and passes with a printed reason when hc or the machine is missing.
