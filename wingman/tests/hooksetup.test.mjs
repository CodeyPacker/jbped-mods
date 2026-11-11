// The Claude hook's settings.json entries (pure), terminal address mapping, and installing,
// re-installing and removing the hook on a machine (the shim runs machine "vps" here).
import { MARK, MATCHER, hookCommand, hookEntries, hookPathOf, parseSettings, hookState, editSettings, withoutHooks, hookSummary, hookStatus, installHook, uninstallHook } from "../mods/wingman/hooksetup.js";
import { addressOn, idOn } from "../mods/wingman/remote.js";
import { remoteCalls } from "herdr";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";

// ---- the entries, as install.sh writes them --------------------------------------------
const hook = "/home/me/.config/herdr-app/data/wingman/wingman-hook.sh";
assert.equal(hookCommand(hook, "post"), `sh '${hook}' post # ${MARK}`);
assert.deepEqual(hookEntries(hook), {
  PostToolUse: { matcher: MATCHER, hooks: [{ type: "command", command: `sh '${hook}' post # herdr-wingman-hook`, timeout: 10 }] },
  UserPromptSubmit: { hooks: [{ type: "command", command: `sh '${hook}' prompt # herdr-wingman-hook`, timeout: 10 }] },
});
// A quote in the path is escaped for sh and read back.
const odd = "/home/o'neil/w/wingman-hook.sh";
assert.equal(hookCommand(odd, "post"), `sh '/home/o'\\''neil/w/wingman-hook.sh' post # ${MARK}`);
assert.equal(hookPathOf(hookCommand(odd, "prompt")), odd);
assert.equal(hookPathOf("sh /x post"), null);

// ---- parse ------------------------------------------------------------------------------
assert.deepEqual(parseSettings(null), {});
assert.deepEqual(parseSettings("  \n"), {});
assert.throws(() => parseSettings("{ nope"), /isn't valid JSON/);
assert.throws(() => parseSettings("[1]"), /isn't a JSON object/);
assert.throws(() => editSettings('{"hooks": ', "install", hook), /isn't valid JSON/);

// ---- add, re-add, keep others, remove exactly ours ----------------------------------------
const other = {
  model: "opus", permissions: { allow: ["Bash(ls)"] },
  hooks: {
    PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo bash" }] }],
    Stop: [{ hooks: [{ type: "command", command: "notify" }] }],
  },
};
const base = JSON.stringify(other, null, 2) + "\n";
const add = editSettings(base, "install", hook);
assert.equal(add.state, "none");
const added = JSON.parse(add.text);
assert.equal(added.model, "opus");
assert.deepEqual(added.permissions, other.permissions);
assert.deepEqual(added.hooks.Stop, other.hooks.Stop);
assert.deepEqual(added.hooks.PostToolUse, [other.hooks.PostToolUse[0], hookEntries(hook).PostToolUse]);
assert.deepEqual(added.hooks.UserPromptSubmit, [hookEntries(hook).UserPromptSubmit]);
assert.equal(hookState(added, hook).state, "installed");
// Again: nothing changes.
const again = editSettings(add.text, "install", hook);
assert.equal(again.text, null);
assert.equal(again.state, "installed");
// Removal gives back the original, byte for byte, and only ours goes.
const rm = editSettings(add.text, "uninstall", hook);
assert.equal(rm.text, base);
assert.equal(editSettings(base, "uninstall", hook).text, null);
// A group holding ours and someone else's keeps theirs.
const shared = { hooks: { PostToolUse: [{ matcher: MATCHER, hooks: [{ type: "command", command: "lint" }, ...hookEntries(hook).PostToolUse.hooks] }] } };
assert.deepEqual(withoutHooks(shared, hook), { hooks: { PostToolUse: [{ matcher: MATCHER, hooks: [{ type: "command", command: "lint" }] }] } });
assert.equal(hookState(shared, hook).state, "partial");
// From nothing: an empty file and a missing one get just the hooks; removing leaves {}.
const fresh = editSettings(null, "install", hook);
assert.deepEqual(Object.keys(JSON.parse(fresh.text)), ["hooks"]);
assert.equal(editSettings(fresh.text, "uninstall", hook).text, "{}\n");

// ---- an existing WSL-style entry (this PC's install.ps1) is detected, never doubled ------------
const winHook = "/mnt/c/Users/me/.config/herdr-app/mods/wingman/hooks/wingman-hook.sh";
const wslText = editSettings(base, "install", winHook).text;
const w = editSettings(wslText, "install", hook);
assert.equal(w.text, null);
assert.equal(w.state, "wsl");
assert.deepEqual(w.existing, [winHook]);
assert.equal(editSettings(wslText, "uninstall", hook).text, null); // not ours to remove
assert.equal(hookState(JSON.parse(editSettings(base, "install", "/opt/w/hook.sh").text), hook).state, "other");
assert.match(hookSummary({ state: "wsl", existing: [winHook], dataThere: true, dataDir: "/d" }, "wsl"), /^Installed by this PC's WSL setup/);
assert.match(hookSummary({ state: "none", existing: [] }, "vps"), /^Not installed on vps/);

// ---- terminal ids across machines --------------------------------------------------------------
assert.equal(addressOn("wsl", "t3"), "wsl/t3");
assert.equal(addressOn("wsl", "wsl/t3"), "wsl/t3");
assert.equal(addressOn(null, "t3"), "t3");
assert.equal(idOn("wsl", "wsl/t3"), "t3");
assert.equal(idOn("wsl", "t3"), "t3");
assert.equal(idOn("vps", "wsl/t3"), "wsl/t3");

// ---- install, re-install, remove on a machine (the shim's "vps") ---------------------------------
const on = "vps", dir = mkdtempSync(`${tmpdir()}/hooksetup-`);
try {
  const data = `${dir}/home/.config/herdr-app/data/wingman`, settings = `${dir}/claude/settings.json`;
  const opts = { dataDir: data, settingsPath: settings }, hookText = "#!/bin/sh\necho hook\n";
  // No folder, no settings file: not installed.
  let s = await hookStatus(on, { ...opts, hookText });
  assert.equal(s.state, "none"); assert.equal(s.dataThere, false); assert.equal(s.settingsText, null);
  remoteCalls.length = 0;
  const msg = await installHook(on, hookText, opts);
  assert.ok(remoteCalls.every((c) => c.on === on));
  assert.match(msg, /copied the hook/); assert.match(msg, /added the hook entries/);
  assert.equal(readFileSync(`${data}/wingman-hook.sh`, "utf8"), hookText);
  assert.ok(existsSync(`${data}/events`) && existsSync(`${data}/feedback`));
  assert.equal(hookState(JSON.parse(readFileSync(settings, "utf8")), `${data}/wingman-hook.sh`).state, "installed");
  assert.ok(!existsSync(`${settings}.bak-herdr-wingman`)); // there was nothing to back up
  s = await hookStatus(on, { ...opts, hookText });
  assert.equal(s.state, "installed"); assert.equal(s.dataThere, true); assert.equal(s.current, true);
  assert.match(hookSummary(s, on), /^Installed on vps/);
  // Again: nothing written.
  const before = readFileSync(settings, "utf8");
  assert.match(await installHook(on, hookText, opts), /^Already installed/);
  assert.equal(readFileSync(settings, "utf8"), before);
  // Remove: the settings file it made goes, so does every folder it made.
  assert.match(await uninstallHook(on, opts), /removed/);
  assert.ok(!existsSync(settings));
  assert.ok(!existsSync(`${dir}/home`));
  assert.ok(existsSync(`${dir}/claude`)); // made by `mkdir -p` of the settings folder: left, it may hold more

  // A settings file with other hooks, and a data folder that was already there (a Herdr home): both kept.
  writeFileSync(settings, base);
  rmSync(`${dir}/home`, { recursive: true, force: true });
  mkdirSync(`${data}/keep`, { recursive: true });
  await installHook(on, hookText, opts);
  assert.equal(readFileSync(`${settings}.bak-herdr-wingman`, "utf8"), base);
  await uninstallHook(on, opts);
  assert.equal(readFileSync(settings, "utf8"), base);
  assert.deepEqual(readdirSync(data).sort(), ["events", "feedback", "keep"]);

  // This PC's WSL setup already has the hook: no second entry, only the folder.
  rmSync(`${dir}/home`, { recursive: true, force: true });
  writeFileSync(settings, wslText);
  const m = await installHook(on, hookText, opts);
  assert.match(m, /already runs/);
  assert.equal(readFileSync(settings, "utf8"), wslText);
  assert.ok(!existsSync(`${data}/wingman-hook.sh`));
  s = await hookStatus(on, opts);
  assert.equal(s.state, "wsl");
  assert.match(hookSummary(s, on), /^Installed by this PC's WSL setup/);
  await uninstallHook(on, opts);
  assert.equal(readFileSync(settings, "utf8"), wslText);
  assert.ok(!existsSync(`${dir}/home`));

  // Not valid JSON: refused, nothing written.
  writeFileSync(settings, "{ broken");
  await assert.rejects(installHook(on, hookText, opts), /isn't valid JSON/);
  assert.equal(readFileSync(settings, "utf8"), "{ broken");
  assert.ok(!existsSync(`${dir}/home`));
} finally { rmSync(dir, { recursive: true, force: true }); }
