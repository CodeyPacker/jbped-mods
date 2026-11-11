# Wingman mod tests

Run all: `sh wingman/tests/run.sh`. Run some: `sh wingman/tests/run.sh git changes`. Needs Node 22+ and git.

`run.sh` builds a temp app home (`WINGMAN_TEST_HOME`, with `mods/wingman` symlinked to the repo and an empty `data/wingman`) and removes it afterward.

`herdr-shim.mjs` stands in for the `"herdr"` module (exec, file IO, `appHome()`). `register.mjs` and `hooks.mjs` map the import to it.

`main.js` imports UI modules and is not covered.

To add a test: create `<name>.test.mjs`, import `../mods/wingman/<file>.js`, use `node:assert`, throw on failure, and keep temp repos in your own `mkdtemp` dirs.
