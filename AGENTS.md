## Agent skills

### Issue tracker

Issues live in GitHub Issues for jbped/herdr-mods, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.

## Testing mods

Test every mod on screen in a private Herdr app with `tools/private-app/private-app`: `start --mod <mod folder>`, then `app <name> check ...`, `app <name> do ...`, `shot <name>`, and `stop <name>` at the end. Never test by copying a mod into the running Herdr (`~/.config/herdr-app/mods`). That has crashed it. Use a committed copy of the mod (`git archive`) when someone else may be editing the working tree. See `tools/private-app/README.md`. `tools/private-app/selftest.sh` checks the tool itself.
