#!/bin/sh
# Installs Wingman into a Herdr home: the wingman and tabs-plus mods, the layout blocks and
# the Claude Code hook. Run it from a clone of this repo. It downloads nothing.
#
#   sh wingman/install.sh [install|uninstall|status] [--no-layout] [--no-hook] [--dry-run] [--purge]
#
#   install     (default) copy the mods, patch or clone a layout, install the hook
#   uninstall   remove the hook, the layout blocks and both mods (data/wingman stays unless --purge)
#   status      show what is installed
#   --no-layout leave layouts alone
#   --no-hook   leave ~/.claude/settings.json alone
#   --dry-run   print every action, write nothing
#   --purge     with uninstall: also delete data/wingman
#
# Herdr home: $HERDR_APP_HOME, else ~/.config/herdr-app (on WSL with Herdr on Windows: the
# Windows profile's .config/herdr-app). Claude settings: ${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json.
# Needs python3 to edit JSON.
set -eu

action=install
no_layout=0 no_hook=0 dry=0 purge=0
for a in "$@"; do
  case "$a" in
    install|uninstall|status) action=$a ;;
    --no-layout) no_layout=1 ;;
    --no-hook) no_hook=1 ;;
    --dry-run) dry=1 ;;
    --purge) purge=1 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $a (try --help)" >&2; exit 2 ;;
  esac
done

share=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$share/.." && pwd)
wing_src="$share/mods/wingman"
tabs_src="$repo/tabs-plus/mods/tabs-plus"
ts=$(date +%Y%m%d-%H%M%S)

die() { echo "Error: $*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
act() { if [ "$dry" = 1 ]; then say "  [dry-run] would $*"; else say "  $*"; fi; }
changed=""   # what changed, one line each
nexts=""     # what the person must do next
note_change() { changed="$changed
  - $*"; }
note_next() { nexts="$nexts
  - $*"; }

command -v python3 >/dev/null 2>&1 || die "python3 is required to edit JSON files"

# ---- Herdr home ----
if [ -n "${HERDR_APP_HOME:-}" ]; then
  home=$HERDR_APP_HOME
else
  home="$HOME/.config/herdr-app"
  if [ ! -d "$home/mods" ] && command -v cmd.exe >/dev/null 2>&1; then
    win=$(cd /mnt/c 2>/dev/null && cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r') || win=""
    [ -n "$win" ] && home="$(wslpath "$win")/.config/herdr-app"
  fi
fi
[ -d "$home/mods" ] && [ -d "$home/layouts" ] ||
  die "$home does not look like a Herdr home (mods/ and layouts/ missing). Start Herdr once, or set HERDR_APP_HOME."
home=$(cd "$home" && pwd)
claude_settings="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"

if [ "$action" = install ]; then
  [ -d "$wing_src" ] && [ -d "$tabs_src" ] ||
    die "Run this from a full clone of the repo: $wing_src and $tabs_src must exist."
fi

# ---- JSON helper (python3) ----
# pylayout patch SRC DST BACKUP|- DRY CLONE_NAME|-   add the blocks; DST may differ from SRC (clone)
# pylayout unpatch FILE BACKUP DRY                   remove the blocks, restore the tabs mod
# pylayout status FILE                               print: stack=<yes|no> blocks=<n> tabs=<mod|none>
# pylayout active HOME                               print: <layout name> <shipped|own|missing>
# Prints "ACT <text>" lines, "NOTE <text>" lines and one "RESULT=<changed|unchanged|nostack>".
pylayout() {
  python3 -I - "$@" <<'PY'
import json, os, shutil, sys, glob

WING = [("wingman-review", "review"), ("wingman-edit", "edit"), ("wingman-changes", "changes")]
MAXPX = 2400


def block(bid, view):
    return {"id": bid, "type": "block", "content": {"mod": "wingman", "props": {"view": view}}}


def walk(node, parent=None):
    yield node, parent
    for c in node.get("children") or []:
        if isinstance(c, dict):
            yield from walk(c, node)


def is_wing(n, view=None):
    c = n.get("content")
    if n.get("type") != "block" or not isinstance(c, dict) or c.get("mod") != "wingman":
        return False
    v = (c.get("props") or {}).get("view")
    return v == view if view else v in [w[1] for w in WING]


def find_stack(root):
    for n, p in walk(root):
        if n.get("id") == "panel-body" and n.get("type") == "stack" and isinstance(n.get("children"), list):
            return n, p
    return None, None


def read(path):
    with open(path, encoding="utf-8", newline="") as f:
        text = f.read()
    if text.startswith("﻿"):
        text = text[1:]
    nl = "\r\n" if "\r\n" in text else "\n"
    indent = 2
    for line in text.split(nl):
        s = line.lstrip(" \t")
        if s and s != line:
            ws = line[: len(line) - len(s)]
            indent = "\t" if ws[0] == "\t" else len(ws)
            break
    return json.loads(text), {"nl": nl, "indent": indent, "eof": text.endswith("\n")}


def write(path, root, fmt):
    out = json.dumps(root, indent=fmt["indent"], ensure_ascii=False)
    if fmt["eof"]:
        out += "\n"
    if fmt["nl"] != "\n":
        out = out.replace("\n", fmt["nl"])
    tmp = path + ".tmp-%d" % os.getpid()
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(out)
    os.replace(tmp, path)


def backup(src, dest):
    n, d = 0, dest
    while os.path.exists(d):
        n += 1
        d = "%s-%d" % (dest, n)
    shutil.copy2(src, d)
    return d


def result(r):
    print("RESULT=" + r)


def patch(src, dst, bak, dry, cloned):
    root, fmt = read(src)
    stack, parent = find_stack(root)
    if stack is None:
        print("NOTE no stack with id \"panel-body\" in %s" % os.path.basename(src))
        return result("nostack")
    acts = []
    for bid, view in WING:
        if any(is_wing(c, view) for c in stack["children"] if isinstance(c, dict)):
            continue
        if any(isinstance(c, dict) and c.get("id") == bid for c in stack["children"]):
            print("NOTE a block with id %s exists but is not Wingman's; skipped" % bid)
            continue
        stack["children"].append(block(bid, view))
        acts.append("add block %s to panel-body" % bid)
    tabs = None
    for n, _ in walk(root):
        c = n.get("content")
        if n.get("type") == "block" and isinstance(c, dict) and c.get("mod") in ("tabs", "tabs-plus"):
            if tabs is None or n.get("id") == "tabs":
                tabs = n
    if tabs is None:
        print("NOTE no tabs block found; Wingman's panel buttons need a tabs block using mod tabs-plus")
    elif tabs["content"]["mod"] == "tabs":
        tabs["content"]["mod"] = "tabs-plus"
        acts.append("point block %s at tabs-plus" % tabs.get("id"))
    if parent is not None and isinstance(parent.get("max"), (int, float)) and not isinstance(parent.get("max"), bool) \
            and parent["max"] < MAXPX:
        acts.append("raise max of %s from %s to %d" % (parent.get("id"), parent["max"], MAXPX))
        parent["max"] = MAXPX
    clone = src != dst
    if clone and "cloned_from" not in root:
        cf = {"name": cloned}
        here = os.path.dirname(src)
        for f in glob.glob(os.path.join(here, "*.json")):
            try:
                o = json.load(open(f, encoding="utf-8"))
            except Exception:
                continue
            c = o.get("cloned_from") if isinstance(o, dict) else None
            if isinstance(c, dict) and c.get("name") == cloned and c.get("version"):
                cf["version"] = c["version"]
                break
        new = {}
        for k, v in root.items():
            new[k] = v
            if k == "id":
                new["cloned_from"] = cf
        if "cloned_from" not in new:
            new = {"cloned_from": cf, **root}
        root = new
        acts.insert(0, "create %s as a copy of %s" % (os.path.basename(dst), os.path.basename(src)))
    for a in acts:
        print("ACT " + a)
    if not acts:
        return result("unchanged")
    if not dry:
        if not clone and bak != "-":
            print("ACT back up to %s" % os.path.basename(backup(src, bak)))
        write(dst, root, fmt)
    return result("changed")


def unpatch(path, bak, dry):
    root, fmt = read(path)
    acts = []
    ids = [w[0] for w in WING]
    for n, _ in walk(root):
        kids = n.get("children")
        keep = [c for c in kids if not (isinstance(c, dict) and c.get("id") in ids and is_wing(c))] if isinstance(kids, list) else None
        if keep is not None and len(keep) != len(kids):
            for c in kids:
                if c not in keep:
                    acts.append("remove block %s" % c["id"])
            n["children"] = keep
            if n.get("active") in ids:
                if keep and isinstance(keep[0], dict) and "id" in keep[0]:
                    n["active"] = keep[0]["id"]
                else:
                    n.pop("active", None)
        c = n.get("content")
        if n.get("type") == "block" and isinstance(c, dict) and c.get("mod") == "tabs-plus":
            c["mod"] = "tabs"
            acts.append("point block %s back at tabs" % n.get("id"))
    for a in acts:
        print("ACT " + a)
    if not acts:
        return result("unchanged")
    if not dry:
        print("ACT back up to %s" % os.path.basename(backup(path, bak)))
        write(path, root, fmt)
    return result("changed")


def status(path):
    root, _ = read(path)
    stack, _p = find_stack(root)
    n = 0
    if stack:
        n = sum(1 for _w, v in WING if any(is_wing(c, v) for c in stack["children"] if isinstance(c, dict)))
    tabs = "none"
    for node, _ in walk(root):
        c = node.get("content")
        if node.get("type") == "block" and isinstance(c, dict) and c.get("mod") in ("tabs", "tabs-plus"):
            tabs = c["mod"]
    print("stack=%s blocks=%d tabs=%s" % ("yes" if stack else "no", n, tabs))


def active(home):
    name = "main"
    try:
        v = json.load(open(os.path.join(home, "shared.json"), encoding="utf-8")).get("layout")
        if isinstance(v, str) and v:
            name = v
    except Exception:
        pass
    path = os.path.join(home, "layouts", name + ".json")
    if "/" in name or "\\" in name or not os.path.isfile(path):
        return print(name, "missing")
    shipped = name in ("main", "terminals", "win98")
    try:
        inst = json.load(open(os.path.join(home, "installed.json"), encoding="utf-8"))
        shipped = ("layout:" + name) in inst
    except Exception:
        pass
    try:
        if isinstance(json.load(open(path, encoding="utf-8")).get("cloned_from"), dict):
            shipped = False
    except Exception:
        pass
    print(name, "shipped" if shipped else "own")


cmd, a = sys.argv[1], sys.argv[2:]
try:
    if cmd == "patch":
        patch(a[0], a[1], a[2], a[3] == "1", a[4])
    elif cmd == "unpatch":
        unpatch(a[0], a[1], a[2] == "1")
    elif cmd == "status":
        status(a[0])
    elif cmd == "active":
        active(a[0])
except (OSError, ValueError) as e:
    print("Error: %s: %s" % (cmd, e), file=sys.stderr)
    sys.exit(1)
PY
}

# Print the helper's ACT/NOTE lines; leave the RESULT word in $res.
res=""
show() {
  out=$(pylayout "$@") || die "layout edit failed"
  res=$(printf '%s\n' "$out" | sed -n 's/^RESULT=//p')
  printf '%s\n' "$out" | while IFS= read -r l; do
    case "$l" in
      "ACT "*) act "${l#ACT }" ;;
      "NOTE "*) say "  note: ${l#NOTE }" ;;
    esac
  done
}

# ---- mods ----
same_tree() { diff -rq -x gpui-kit.d.ts -x jsconfig.json "$1" "$2" >/dev/null 2>&1; }

copy_mod() { # src name
  src=$1 name=$2 dest="$home/mods/$2"
  if [ -L "$dest" ]; then
    say "  mods/$name is a link; left alone (Herdr does not hot-reload linked folders)"
    return
  fi
  if [ -d "$dest" ] && same_tree "$src" "$dest"; then
    say "  mods/$name is up to date"
    return
  fi
  if [ -d "$dest" ]; then act "replace mods/$name"; else act "copy mods/$name"; fi
  [ "$dry" = 1 ] && return
  tmp="$home/.wingman-install.$$"
  rm -rf "$tmp"; mkdir "$tmp"
  cp -R "$src/." "$tmp/"
  # Herdr writes these into each mod folder; keep its copies.
  for f in gpui-kit.d.ts jsconfig.json; do
    rm -f "$tmp/$f"
    [ -f "$dest/$f" ] && cp "$dest/$f" "$tmp/$f"
  done
  if [ -d "$dest" ]; then mv "$dest" "$tmp.old"; fi
  mv "$tmp" "$dest"
  rm -rf "$tmp.old"
  note_change "mods/$name installed"
}

# ---- layout ----
layout_install() {
  say "Layout"
  set -- $(pylayout active "$home"); name=$1 kind=$2
  case "$kind" in
    missing) say "  the active layout \"$name\" has no file in layouts/; layout not changed"
             note_next "Make a layout of your own (Duplicate layout in the palette), switch to it, and run this again."
             return ;;
  esac
  lay="$home/layouts"
  if [ "$kind" = shipped ]; then
    target="$name-wingman"
    say "  active layout \"$name\" is shipped (read-only); using the copy \"$target\""
    if [ -f "$lay/$target.json" ]; then
      show patch "$lay/$target.json" "$lay/$target.json" "$lay/$target.json.bak-$ts" "$dry" "$name"
    else
      show patch "$lay/$name.json" "$lay/$target.json" - "$dry" "$name"
    fi
    case "$res" in
      nostack) no_stack_help; return ;;
      changed) note_change "layout $target.json created or updated" ;;
    esac
    switch_to "$target"
  else
    say "  active layout \"$name\" is your own"
    show patch "$lay/$name.json" "$lay/$name.json" "$lay/$name.json.bak-$ts" "$dry" "$name"
    case "$res" in
      nostack) no_stack_help; return ;;
      changed) note_change "layout $name.json patched (backup: $name.json.bak-$ts)" ;;
      unchanged) say "  already patched" ;;
    esac
  fi
}

no_stack_help() {
  say "  no side panel stack found, so no layout was changed. Add these by hand:"
  say "    - to a stack with id \"panel-body\", three blocks:"
  for v in review edit changes; do
    say "        {\"id\":\"wingman-$v\",\"type\":\"block\",\"content\":{\"mod\":\"wingman\",\"props\":{\"view\":\"$v\"}}}"
  done
  say "    - set the tabs block's \"content\":{\"mod\":\"tabs-plus\"}"
  say "    - raise \"max\" of the column holding the stack to 2400"
  note_next "Add the Wingman blocks to your layout by hand (see above)."
}

switch_to() { # layout name
  if [ "$dry" = 1 ]; then act "switch to layout $1"; return; fi
  if command -v herdr-app >/dev/null 2>&1 &&
     herdr-app do layout.switch "{\"name\":\"$1\"}" >/dev/null 2>&1; then
    say "  switched to layout $1"
    note_change "active layout is now $1"
  else
    note_next "Switch to the layout \"$1\": ctrl-shift-l, or Settings."
  fi
}

layout_uninstall() {
  say "Layout"
  found=0
  for f in "$home"/layouts/*.json; do
    [ -f "$f" ] || continue
    b=$(basename "$f" .json)
    show unpatch "$f" "$f.bak-$ts" "$dry"
    if [ "$res" = changed ]; then
      found=1
      note_change "layout $b.json restored (backup: $b.json.bak-$ts)"
    fi
  done
  [ "$found" = 1 ] || say "  no layout had Wingman's blocks"
}

# ---- hook ----
hook_install() {
  say "Claude Code hook"
  inst="$home/mods/wingman/install/install.sh"
  if [ "$dry" = 1 ]; then act "run $inst install (settings: $claude_settings)"; return; fi
  [ -f "$inst" ] || { say "  mod not installed; hook skipped"; return; }
  if grep -q herdr-wingman-hook "$claude_settings" 2>/dev/null; then had=1; else had=0; fi
  HERDR_WINGMAN_DIR="$home/data/wingman" CLAUDE_CONFIG_DIR="$(dirname "$claude_settings")" sh "$inst" install | sed 's/^/  /'
  if [ "$had" = 0 ]; then
    note_change "hook added to $claude_settings"
    note_next "Restart running Claude Code sessions so they load the hook."
  fi
  case "$home" in
    /mnt/?/*) note_next "Herdr is on Windows: also run install.ps1 once in PowerShell, so Windows terminals pass HERDR_WINGMAN_DIR and HC_TERMINAL_ID to WSL." ;;
  esac
}

hook_uninstall() {
  say "Claude Code hook"
  inst="$wing_src/install/install.sh"
  [ -f "$inst" ] || inst="$home/mods/wingman/install/install.sh"
  if [ "$dry" = 1 ]; then act "run $inst uninstall (settings: $claude_settings)"; return; fi
  [ -f "$inst" ] || { say "  hook installer not found; hook left alone"; return; }
  if ! grep -q herdr-wingman-hook "$claude_settings" 2>/dev/null; then say "  no hook installed"; return; fi
  HERDR_WINGMAN_DIR="$home/data/wingman" CLAUDE_CONFIG_DIR="$(dirname "$claude_settings")" sh "$inst" uninstall | sed 's/^/  /'
  note_change "hook removed from $claude_settings"
  note_next "Restart running Claude Code sessions."
}

# ---- status ----
mod_status() { # src name
  dest="$home/mods/$2"
  if [ -L "$dest" ]; then say "  mods/$2: linked folder"
  elif [ ! -d "$dest" ]; then say "  mods/$2: not installed"
  elif [ -d "$1" ] && same_tree "$1" "$dest"; then say "  mods/$2: installed, matches the repo copy"
  elif [ -d "$1" ]; then say "  mods/$2: installed, differs from the repo copy"
  else say "  mods/$2: installed (no repo copy to compare)"; fi
}

do_status() {
  say "Mods"
  mod_status "$wing_src" wingman
  mod_status "$tabs_src" tabs-plus
  say "Layout"
  set -- $(pylayout active "$home"); say "  active: $1 ($2)"
  any=0
  for f in "$home"/layouts/*.json; do
    [ -f "$f" ] || continue
    s=$(pylayout status "$f") || continue
    case "$s" in "stack=yes blocks=0 "*|"stack=no "*) continue ;; esac
    any=1
    say "  $(basename "$f"): $s"
  done
  [ "$any" = 1 ] || say "  no layout has Wingman's blocks"
  say "Hook"
  if grep -q herdr-wingman-hook "$claude_settings" 2>/dev/null; then
    say "  installed in $claude_settings"
  else
    say "  not installed in $claude_settings"
  fi
}

# ---- run ----
[ "$dry" = 1 ] && say "Dry run: nothing will be written."
say "Herdr home: $home"
case "$action" in
  status) do_status; exit 0 ;;
  install)
    say "Mods"
    copy_mod "$wing_src" wingman
    copy_mod "$tabs_src" tabs-plus
    [ "$no_layout" = 1 ] && say "Layout skipped (--no-layout)" || layout_install
    [ "$no_hook" = 1 ] && say "Hook skipped (--no-hook)" || hook_install
    ;;
  uninstall)
    [ "$no_hook" = 1 ] && say "Hook skipped (--no-hook)" || hook_uninstall
    [ "$no_layout" = 1 ] && say "Layout skipped (--no-layout)" || layout_uninstall
    say "Mods"
    for name in wingman tabs-plus; do
      d="$home/mods/$name"
      if [ -L "$d" ]; then say "  mods/$name is a link; left alone"
      elif [ -d "$d" ]; then act "remove mods/$name"; [ "$dry" = 1 ] || { rm -rf "$d"; note_change "mods/$name removed"; }
      else say "  mods/$name not installed"; fi
    done
    if [ -d "$home/data/wingman" ]; then
      if [ "$purge" = 1 ]; then
        act "delete data/wingman"; [ "$dry" = 1 ] || { rm -rf "$home/data/wingman"; note_change "data/wingman deleted"; }
      else
        say "  data/wingman kept (use --purge to delete it)"
      fi
    fi
    ;;
esac

say ""
if [ "$dry" = 1 ]; then
  say "Dry run done. Nothing was written."
  exit 0
fi
if [ -n "$changed" ]; then say "Changed:$changed"; else say "Nothing changed."; fi
if [ "$action" = install ] && [ -n "$changed" ]; then
  note_next "Herdr reloads mods and layouts itself; no restart needed for those."
fi
[ -n "$nexts" ] && say "Next:$nexts"
exit 0
