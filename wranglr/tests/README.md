# Wranglr mod tests

Run all: `sh wranglr/tests/run.sh`. Run some: `sh wranglr/tests/run.sh config repos`. Needs Node 22+ and git.

`run.sh` makes a temp app home, exports it as `WRANGLR_TEST_HOME`, runs each `<name>.test.mjs` with `node --import ./register.mjs --test`, prints `ok <name>` or `FAIL <name>` with the output, and exits non-zero on any failure. The temp home is removed afterward.

`register.mjs` and `hooks.mjs` map the `"herdr"` import to `herdr-shim.mjs`, and `"fs/promises"` to Node's.

`herdr-shim.mjs` provides:
- `exec`: runs the real program here and records every call in `execCalls`. A call with `on` (another Machine) runs here too. `fake.exec(cmd, args, opts)` can answer first; returning undefined falls through.
- `readTextFile` (`fake.read` can answer first) and `writeTextFile` with real compare-and-swap on real files (`fake.write` can answer first). Writes are recorded in `writeCalls`, and `writes.max` is the most that ran at once.
- `appHome()` (`WRANGLR_TEST_HOME`) and `home()` (`<app home>/home`).
- `run` recorded in `runCalls`, `notify` recorded in `notes`, `window()` with `platform` from `win.platform` (`"linux"` by default).
- `reset()` clears the fakes and the records. Call it in `beforeEach`.

To add a test: create `<name>.test.mjs`, import `../mods/wranglr/<file>.js` and what you need from `"herdr"`, use `node:test` and `node:assert/strict`, and keep temp repos in your own `mkdtemp` folders.
