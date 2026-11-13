#!/bin/sh
# Tests wingman/install.sh and, when powershell.exe is reachable, wingman/install.ps1.
#   sh wingman/tests/install/run.sh
# Everything runs against throwaway Herdr homes and Claude settings in a temp folder.
# The real Herdr config is only read (layouts and settings.json are copied from it when present).
# The PowerShell pass skips the hook: the hook step sets real Windows user variables.
set -u
here=$(cd "$(dirname "$0")" && pwd)
share=$(cd "$here/../.." && pwd)
fx="$here/fixtures"
real="${WINGMAN_TEST_REAL_HOME:-/mnt/c/Users/jakep/.config/herdr-app}"

root=$(mktemp -d)
export HOME="$root/home"; mkdir -p "$HOME"
unset HERDR_WINGMAN_DIR CLAUDE_CONFIG_DIR HERDR_APP_HOME
trap 'rm -rf "$root"; [ -n "${wroot:-}" ] && rm -rf "$wroot"' EXIT INT TERM

pass=0 fail=0
ok() { pass=$((pass + 1)); echo "ok   $MODE $1"; }
bad() { fail=$((fail + 1)); echo "FAIL $MODE $1"; [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/       /'; }
check() { # name, command...
  n=$1; shift
  if "$@" >/dev/null 2>&1; then ok "$n"; else bad "$n"; fi
}

# ---- installer runner: run_inst <install|uninstall|status> [dry] [nolayout] [nohook] [purge] ----
MODE=sh
run_inst() {
  act=$1; shift
  if [ "$MODE" = sh ]; then
    flags=""
    for f in "$@"; do
      case $f in dry) flags="$flags --dry-run" ;; nolayout) flags="$flags --no-layout" ;; nohook) flags="$flags --no-hook" ;; purge) flags="$flags --purge" ;; esac
    done
    # shellcheck disable=SC2086
    sh "$share/install.sh" "$act" $flags 2>&1
  else
    flags=""
    for f in "$@"; do
      case $f in dry) flags="$flags -DryRun" ;; nolayout) flags="$flags -NoLayout" ;; nohook) flags="$flags -NoHook" ;; purge) flags="$flags -Purge" ;; esac
    done
    # shellcheck disable=SC2086
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$share/install.ps1")" $act $flags 2>&1 | tr -d '\r'
    return 0
  fi
}

valid_json() { # every layout, shared.json and (sh) the Claude settings parse
  for f in "$H"/layouts/*.json "$H/shared.json" "$CLAUDE_CONFIG_DIR/settings.json"; do
    [ -f "$f" ] || continue
    python3 -I -c 'import json,sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$f" || { echo "invalid: $f"; return 1; }
  done
}

# A fresh Herdr home in $base: layouts from fixtures (and the real ones when present), settings, installed.json.
new_home() { # name, active layout
  H="$base/$1"; export HERDR_APP_HOME="$H"
  [ "$MODE" = ps ] && export WSLENV="HERDR_APP_HOME/p:CLAUDE_CONFIG_DIR/p"
  export CLAUDE_CONFIG_DIR="$base/$1-claude"
  mkdir -p "$H/mods/tabs" "$H/mods/other" "$H/layouts/.state" "$H/data"
  echo 'tabs-original' >"$H/mods/tabs/main.js"; echo 'other' >"$H/mods/other/main.js"
  cp "$fx/shipped.json" "$H/layouts/fakeship.json"
  cp "$fx/own.json" "$H/layouts/mine.json"
  cp "$fx/nostack.json" "$H/layouts/nostack.json"
  if [ -d "$real/layouts" ]; then
    cp "$real/layouts/main.json" "$real/layouts/terminals.json" "$real/layouts/win98.json" "$H/layouts/" 2>/dev/null
    [ -f "$real/settings.json" ] && cp "$real/settings.json" "$H/settings.json"
  fi
  printf '{"layout:fakeship":{"json":"x"},"layout:main":{"json":"x"},"layout:terminals":{"json":"x"},"layout:win98":{"json":"x"}}\n' >"$H/installed.json"
  printf '{"layout":"%s","other":1}\n' "$2" >"$H/shared.json"
  echo '{"theme":"keep-me"}' >"$H/layouts/.state/mine.json"
  guard
}

# The PowerShell side must see the temp folder, never the real Herdr home. Abort if it does not.
guard() {
  [ "$MODE" = ps ] || return 0
  g=$(run_inst status nohook 2>&1 | head -3)
  case "$g" in *wingman-itest*) ;; *) echo "ABORT: PowerShell did not receive HERDR_APP_HOME"; echo "$g"; exit 1 ;; esac
}

has_text() { grep -qF -- "$2" "$1"; }
line2_is() { sed -n 2p "$1" | grep -q "^$2\"id\""; }

snap() { (cd "$H" && find . -type f -exec sha256sum {} + | sort -k2); if [ -d "$CLAUDE_CONFIG_DIR" ]; then (cd "$CLAUDE_CONFIG_DIR" && find . -type f -exec sha256sum {} + | sort -k2); else echo "no-claude-dir"; fi; }
sha() { sha256sum "$1" | cut -d' ' -f1; }

# Python assertions on layout files: py_check <script using a, b = json docs of argv[1], argv[2]>
pyj() { python3 -I -c "
import json,sys
def ld(p): return json.load(open(p,encoding='utf-8'))
def walk(n):
    yield n
    for c in n.get('children') or []: yield from walk(c)
$1" "$2" "${3:-}"; }

run_suite() {
  base="$root/$MODE"; mkdir -p "$base"
  [ "$MODE" = ps ] && HOOK=0 || HOOK=1
  NOHOOK=nohook; [ "$HOOK" = 1 ] && NOHOOK=""

  # --- refuses a folder that is not a Herdr home
  mkdir -p "$base/empty"
  new_home empty0 main; rm -rf "$H"; mkdir -p "$base/empty"; export HERDR_APP_HOME="$base/empty"
  guard
  out=$(run_inst install dry nohook)
  case "$out" in *"does not look like a Herdr home"*) ok "refuses a non-Herdr folder" ;; *) bad "refuses a non-Herdr folder" "$out" ;; esac
  [ -z "$(ls -A "$base/empty")" ] && ok "wrote nothing into it" || bad "wrote nothing into it"

  # --- fresh install onto a shipped layout
  new_home a fakeship
  cp "$H/layouts/fakeship.json" "$base/fakeship.orig"
  out=$(run_inst install $NOHOOK)
  check "install: wingman mod copied" diff -r -x gpui-kit.d.ts -x jsconfig.json "$share/mods/wingman" "$H/mods/wingman"
  check "install: tabs-plus mod copied" diff -r -x gpui-kit.d.ts -x jsconfig.json "$share/../tabs-plus/mods/tabs-plus" "$H/mods/tabs-plus"
  check "install: other mods untouched" sh -c "[ \"\$(cat '$H/mods/tabs/main.js')\" = tabs-original ] && [ \"\$(cat '$H/mods/other/main.js')\" = other ]"
  check "shipped layout is not edited" cmp "$base/fakeship.orig" "$H/layouts/fakeship.json"
  check "shipped layout is cloned to fakeship-copy" test -f "$H/layouts/fakeship-copy.json"
  check "clone has cloned_from, 3 blocks after files and changes, tabs-plus, max 2400, rest intact" pyj '
a=ld(sys.argv[1]); b=ld(sys.argv[2])
assert b["cloned_from"]["name"]=="fakeship", b.get("cloned_from")
assert list(b)[:2]==["id","cloned_from"]
sb=[n for n in walk(b) if n.get("id")=="panel-body"][0]
assert [c["id"] for c in sb["children"]]==["files","changes","wingman-review","wingman-edit","wingman-changes"]
assert [c["content"]["props"]["view"] for c in sb["children"][2:]]==["review","edit","changes"]
t=[n for n in walk(b) if n.get("id")=="tabs"][0]; assert t["content"]["mod"]=="tabs-plus"
assert t["size"]=={"weight":1.5} and t["window_drag"] is True
p=[n for n in walk(b) if n.get("id")=="panel"][0]; assert p["max"]==2400 and p["min"]==280 and p["hidden"] is True
# remove our changes and compare with the original
assert [c["content"]["props"] for c in sb["children"][2:]]==[{"view":"review","added":True,"max_was":900},{"view":"edit","added":True},{"view":"changes","added":True}]
assert t["content"]=={"mod":"tabs-plus","props":{"replaces":"tabs"}}
sb["children"]=sb["children"][:2]; t["content"]={"mod":"tabs"}; p["max"]=900; del b["cloned_from"]
assert a==b, "other content changed"
' "$H/layouts/fakeship.json" "$H/layouts/fakeship-copy.json"
  check "clone keeps the 2-space style and final newline" sh -c "sed -n 2p '$H/layouts/fakeship-copy.json' | grep -q '^  \"id\"' && [ \"\$(tail -c1 '$H/layouts/fakeship-copy.json' | od -An -c | tr -d ' ')\" = '\\n' ]"
  check "JSON valid after install" valid_json
  case "$out" in *"Switch to the layout \"fakeship-copy\""*) ok "tells the person how to switch layout" ;; *) bad "tells the person how to switch layout" "$out" ;; esac
  if [ "$HOOK" = 1 ]; then
    check "hook installed with the marker and pointing into the Herdr home" sh -c "grep -q herdr-wingman-hook '$CLAUDE_CONFIG_DIR/settings.json' && grep -q \"$H/mods/wingman/hooks/wingman-hook.sh\" '$CLAUDE_CONFIG_DIR/settings.json'"
    check "hook data folder created in the Herdr home" test -d "$H/data/wingman"
  fi

  # --- second install is a no-op
  before=$(snap)
  out=$(run_inst install $NOHOOK)
  [ "$HOOK" = 1 ] && before=$(echo "$before" | grep -v 'bak-herdr-wingman')
  after=$(snap); [ "$HOOK" = 1 ] && after=$(echo "$after" | grep -v 'bak-herdr-wingman')
  if [ "$before" = "$after" ]; then ok "second install changes no file"; else
    printf '%s\n' "$before" >"$root/b.txt"; printf '%s\n' "$after" >"$root/a.txt"
    bad "second install changes no file" "$(diff "$root/b.txt" "$root/a.txt")"; fi
  check "second install says nothing changed" sh -c "echo '$out' | grep -q 'Nothing changed'"

  # --- dry run writes nothing
  new_home b fakeship
  before=$(snap)
  out=$(run_inst install dry)
  after=$(snap)
  [ "$before" = "$after" ] && ok "dry-run install writes nothing" || bad "dry-run install writes nothing"
  case "$out" in *"would"*"fakeship-copy"*) ok "dry-run prints the actions" ;; *) bad "dry-run prints the actions" "$out" ;; esac
  [ ! -e "$CLAUDE_CONFIG_DIR" ] && ok "dry-run does not create Claude settings" || bad "dry-run does not create Claude settings"
  run_inst install $NOHOOK >/dev/null
  before=$(snap); run_inst uninstall dry >/dev/null; after=$(snap)
  [ "$before" = "$after" ] && ok "dry-run uninstall writes nothing" || bad "dry-run uninstall writes nothing"

  # --- user layout: backup, patch, other blocks untouched, idempotent
  new_home c mine
  cp "$H/layouts/mine.json" "$base/mine.orig"
  out=$(run_inst install $NOHOOK)
  check "own layout: backup written beside it, equal to the original" sh -c "ls '$H/layouts'/mine.json.bak-* >/dev/null && cmp '$base/mine.orig' \"\$(ls '$H/layouts'/mine.json.bak-* | head -1)\""
  check "own layout: no extra layout file" sh -c "[ ! -e '$H/layouts/mine-copy.json' ]"
  check "own layout: blocks added after the others, other blocks and keys untouched, max 3000 not lowered" pyj '
a=ld(sys.argv[1]); b=ld(sys.argv[2])
sb=[n for n in walk(b) if n.get("id")=="panel-body"][0]
assert [c["id"] for c in sb["children"]]==["files","changes","wayfinder","mine","wingman-review","wingman-edit","wingman-changes"]
assert [n for n in walk(b) if n.get("id")=="panel"][0]["max"]==3000
assert [n for n in walk(b) if n.get("id")=="tabs"][0]["content"]["mod"]=="tabs-plus"
sb["children"]=sb["children"][:4]; [n for n in walk(b) if n.get("id")=="tabs"][0]["content"]={"mod":"tabs"}
assert a==b
' "$base/mine.orig" "$H/layouts/mine.json"
  check "own layout: keeps the 4-space indent" line2_is "$H/layouts/mine.json" '    '
  check "own layout: keeps non-ASCII text and escapes" has_text "$H/layouts/mine.json" 'café \"q\"'
  check "own layout: click state file untouched" sh -c "[ \"\$(cat '$H/layouts/.state/mine.json')\" = '{\"theme\":\"keep-me\"}' ]"
  check "JSON valid after own-layout install" valid_json
  nb=$(ls "$H/layouts" | grep -c 'mine.json.bak-')
  s1=$(sha "$H/layouts/mine.json"); run_inst install $NOHOOK >/dev/null
  [ "$s1" = "$(sha "$H/layouts/mine.json")" ] && [ "$nb" = "$(ls "$H/layouts" | grep -c 'mine.json.bak-')" ] && ok "own layout: second install is byte-identical, no new backup" || bad "own layout: second install is byte-identical, no new backup"

  # --- status
  out=$(run_inst status)
  case "$out" in *"mods"?"wingman: installed, matches the repo copy"*) ok "status: wingman matches" ;; *) bad "status: wingman matches" "$out" ;; esac
  case "$out" in *"mods"?"tabs-plus: installed, matches the repo copy"*) ok "status: tabs-plus matches" ;; *) bad "status: tabs-plus matches" "$out" ;; esac
  case "$out" in *"mine.json: stack=yes blocks=3 tabs=tabs-plus"*) ok "status: layout patched" ;; *) bad "status: layout patched" "$out" ;; esac
  case "$out" in *"active: mine (own)"*) ok "status: active layout is own" ;; *) bad "status: active layout is own" "$out" ;; esac
  echo 'changed' >>"$H/mods/wingman/README.md"
  out=$(run_inst status)
  case "$out" in *"wingman: installed, differs"*) ok "status: notices a changed mod" ;; *) bad "status: notices a changed mod" "$out" ;; esac
  run_inst install $NOHOOK >/dev/null
  check "install replaces a changed mod copy" diff -r -x gpui-kit.d.ts -x jsconfig.json "$share/mods/wingman" "$H/mods/wingman"

  # --- uninstall restores the layout
  if [ "$HOOK" = 1 ]; then run_inst install >/dev/null; fi
  mkdir -p "$H/data/wingman/events"; echo keep >"$H/data/wingman/events/x"
  out=$(run_inst uninstall $NOHOOK)
  check "uninstall: layout equals the original" pyj 'assert ld(sys.argv[1])==ld(sys.argv[2])' "$base/mine.orig" "$H/layouts/mine.json"
  check "uninstall: mods removed" sh -c "[ ! -e '$H/mods/wingman' ] && [ ! -e '$H/mods/tabs-plus' ]"
  check "uninstall: other mods untouched" sh -c "[ \"\$(cat '$H/mods/tabs/main.js')\" = tabs-original ] && [ -d '$H/mods/other' ]"
  check "uninstall: data kept without --purge" test -f "$H/data/wingman/events/x"
  [ "$HOOK" = 1 ] && check "uninstall: hook removed" sh -c "! grep -q herdr-wingman-hook '$CLAUDE_CONFIG_DIR/settings.json'"
  check "JSON valid after uninstall" valid_json
  run_inst install $NOHOOK >/dev/null
  run_inst uninstall $NOHOOK purge >/dev/null
  check "uninstall --purge deletes data" sh -c "[ ! -e '$H/data/wingman' ]"

  # --- uninstall after a shipped-layout install: the clone is restored, the shipped file never touched
  new_home d fakeship
  cp "$H/layouts/fakeship.json" "$base/fakeship.orig"
  run_inst install $NOHOOK >/dev/null; run_inst uninstall $NOHOOK >/dev/null
  check "shipped path: clone restored to stock content" pyj '
a=ld(sys.argv[1]); b=ld(sys.argv[2]); b.pop("cloned_from"); p=[n for n in walk(b) if n.get("id")=="panel"][0]; p["max"]=900
assert a==b' "$base/fakeship.orig" "$H/layouts/fakeship-copy.json"
  check "shipped path: shipped file still untouched" cmp "$base/fakeship.orig" "$H/layouts/fakeship.json"

  # --- re-use of an existing clone
  new_home e fakeship
  run_inst install $NOHOOK >/dev/null
  n1=$(ls "$H/layouts" | wc -l)
  run_inst install $NOHOOK >/dev/null
  [ "$n1" = "$(ls "$H/layouts" | wc -l)" ] && ok "second shipped-layout install creates no new files" || bad "second shipped-layout install creates no new files"

  # --- no panel stack
  new_home f nostack
  cp "$H/layouts/nostack.json" "$base/nostack.orig"
  out=$(run_inst install $NOHOOK)
  check "no stack: layout byte-identical" cmp "$base/nostack.orig" "$H/layouts/nostack.json"
  check "no stack: no backup or clone created" sh -c "[ \"\$(ls '$H/layouts' | grep -c -e bak -e wingman)\" = 0 ]"
  case "$out" in *"no side panel stack"*"wingman-review"*) ok "no stack: prints what to add by hand" ;; *) bad "no stack: prints what to add by hand" "$out" ;; esac
  check "no stack: mods still installed" test -d "$H/mods/wingman"

  # --- flags
  new_home g mine
  before=$(sha "$H/layouts/mine.json")
  run_inst install nolayout $NOHOOK >/dev/null
  [ "$before" = "$(sha "$H/layouts/mine.json")" ] && [ -d "$H/mods/wingman" ] && ok "--no-layout leaves layouts alone" || bad "--no-layout leaves layouts alone"
  if [ "$HOOK" = 1 ]; then
    new_home h mine
    run_inst install nohook >/dev/null
    [ ! -e "$CLAUDE_CONFIG_DIR/settings.json" ] && ok "--no-hook leaves Claude settings alone" || bad "--no-hook leaves Claude settings alone"
    # existing settings: other hooks and keys survive install and uninstall
    mkdir -p "$CLAUDE_CONFIG_DIR"
    echo '{"theme":"dark","hooks":{"PostToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo hi"}]}]}}' >"$CLAUDE_CONFIG_DIR/settings.json"
    run_inst install >/dev/null; run_inst uninstall >/dev/null
    check "hook install and uninstall keep other settings" sh -c "grep -q '\"theme\": \"dark\"' '$CLAUDE_CONFIG_DIR/settings.json' && grep -q 'echo hi' '$CLAUDE_CONFIG_DIR/settings.json' && ! grep -q herdr-wingman '$CLAUDE_CONFIG_DIR/settings.json'"
  fi

  # --- a linked mod folder is left alone
  new_home i mine
  mkdir -p "$base/devcopy"; echo dev >"$base/devcopy/main.js"
  ln -s "$base/devcopy" "$H/mods/wingman"
  out=$(run_inst install $NOHOOK)
  check "linked mod folder is not replaced" sh -c "[ -L '$H/mods/wingman' ] && [ \"\$(cat '$base/devcopy/main.js')\" = dev ]"
  run_inst uninstall $NOHOOK >/dev/null
  check "uninstall leaves a linked mod and its target" sh -c "[ -L '$H/mods/wingman' ] && [ -f '$base/devcopy/main.js' ]"

  # --- switching through the herdr-app command line (sh only; the stub records its arguments)
  if [ "$MODE" = sh ]; then
    new_home j fakeship
    mkdir -p "$base/bin"; log="$base/herdr-app.log"; : >"$log"
    printf '#!/bin/sh\necho "$@" >>"%s"\n' "$log" >"$base/bin/herdr-app"; chmod +x "$base/bin/herdr-app"
    out=$(PATH="$base/bin:$PATH" run_inst install $NOHOOK)
    check "switches layout through herdr-app when available" grep -q 'do layout.switch {"name":"fakeship-copy"}' "$log"
    case "$out" in *"Switch to the layout"*) bad "no manual switch hint after a switch" "$out" ;; *) ok "no manual switch hint after a switch" ;; esac
  fi
}

# ---- sh ----
run_suite

# ---- the hook installer itself (mods/wingman/install/install.sh): a linked settings.json, a ' in the path ----
MODE=sh
hb="$root/hook it's here"; mkdir -p "$hb/wingman/install" "$hb/wingman/hooks" "$root/dotfiles" "$root/hookcfg"
cp "$share/mods/wingman/install/install.sh" "$hb/wingman/install/"
printf '#!/bin/sh\necho "ran $1" >>"%s"\n' "$root/hook.log" >"$hb/wingman/hooks/wingman-hook.sh"
echo '{"theme":"dark"}' >"$root/dotfiles/settings.json"; chmod 600 "$root/dotfiles/settings.json"
ln -s "$root/dotfiles/settings.json" "$root/hookcfg/settings.json"
if CLAUDE_CONFIG_DIR="$root/hookcfg" HERDR_WINGMAN_DIR="$root/hookdata" sh "$hb/wingman/install/install.sh" install >/dev/null 2>&1; then
  check "hook installer: a linked settings.json stays a link" test -L "$root/hookcfg/settings.json"
  check "hook installer: the hooks went into the link's target" grep -q herdr-wingman-hook "$root/dotfiles/settings.json"
  check "hook installer: the target keeps its mode" sh -c "[ \"\$(stat -c %a '$root/dotfiles/settings.json')\" = 600 ]"
  # Each hook command runs the hook, whatever the path holds.
  : >"$root/hook.log"
  python3 -I -c 'import json,sys; [print(h["command"]) for e in json.load(open(sys.argv[1]))["hooks"].values() for g in e for h in g["hooks"]]' "$root/hookcfg/settings.json" >"$root/cmds"
  while IFS= read -r c; do sh -c "$c"; done <"$root/cmds"
  check "hook installer: a ' in the path still runs the hook" sh -c "grep -qx 'ran post' '$root/hook.log' && grep -qx 'ran prompt' '$root/hook.log'"
  CLAUDE_CONFIG_DIR="$root/hookcfg" sh "$hb/wingman/install/install.sh" uninstall >/dev/null 2>&1
  check "hook installer: uninstall through the link keeps it a link and the other keys" sh -c "[ -L '$root/hookcfg/settings.json' ] && grep -q '\"theme\": \"dark\"' '$root/dotfiles/settings.json' && ! grep -q herdr-wingman '$root/dotfiles/settings.json'"
else bad "hook installer runs"; fi

# ---- the real layouts parse and round-trip through a patch cleanly (when present) ----
if [ -d "$real/layouts" ]; then
  MODE=sh
  new_home r main
  out=$(run_inst install $NOHOOK)
  check "real main layout cloned to main-copy, main.json untouched" sh -c "[ -f '$H/layouts/main-copy.json' ] && cmp '$real/layouts/main.json' '$H/layouts/main.json'"
  check "real main clone: 3 blocks and tabs-plus" sh -c "python3 -I -c 'import json,sys; d=json.dumps(json.load(open(sys.argv[1]))); assert d.count(\"wingman-review\")==1 and \"tabs-plus\" in d' '$H/layouts/main-copy.json'"
  check "JSON valid for the real layouts" valid_json
fi

# ---- PowerShell ----
if command -v powershell.exe >/dev/null 2>&1; then
  wtmp=$(cmd.exe /c 'echo %TEMP%' 2>/dev/null | tr -d '\r')
  if [ -n "$wtmp" ] && wroot=$(mktemp -d -p "$(wslpath "$wtmp")" wingman-itest-XXXXXX 2>/dev/null); then
    MODE=ps
    root_save=$root; root=$wroot
    run_suite
    root=$root_save
  else
    echo "skip powershell: no writable Windows temp folder"
  fi
else
  echo "skip powershell: powershell.exe not reachable"
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
