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
# Windows profile's .config/herdr-app). HERDR_APP_BIN: the herdr-app program to ask to switch layouts
# (default: herdr-app on PATH, called with HERDR_APP_HOME set to that home). Claude settings: ${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json.
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
# pylayout unpatch FILE BACKUP DRY                   undo exactly what patch did
# pylayout keys FILE BACKUP DRY                      remove Wingman's bindings from keys.json
# pylayout settings FILE DRY                         set hideHerdrPanels false in Wingman's settings.json
# pylayout panels HOME BACKUP DRY                    put back the panel buttons Wingman hid (shared.json)
# pylayout status FILE                               print: stack=<yes|no> blocks=<n> tabs=<mod|none>
# pylayout active HOME                               print: <layout name> <shipped|own|missing>
# Prints "ACT <text>" lines, "NOTE <text>" lines and one "RESULT=<changed|unchanged|nostack>".
pylayout() {
  python3 -I - "$@" <<'PY'
import json, os, shutil, sys, glob

WING = [("wingman-review", "review"), ("wingman-edit", "edit"), ("wingman-changes", "changes")]
MAXPX = 2400


# What patch does to a layout (each edit is kept in the node itself, so unpatch undoes exactly it):
#   - adds three blocks to the "panel-body" stack, each with props.added = true
#   - the tabs block (mod "tabs") becomes "tabs-plus", the old mod kept in props.replaces
#   - the max of the stack's parent, when below MAXPX, becomes MAXPX; the old max is kept in
#     props.max_was on the first Wingman block
#   - adds the capture controller block "wingman-capture" to the root's floating list (add_ctl)
def block(bid, view):
    return {"id": bid, "type": "block", "content": {"mod": "wingman", "props": {"view": view, "added": True}}}


# The capture controller: an empty block in the root's floating list, always rendered. Marked like
# the panel blocks (props.added = true); props.list_added = true when patch created the floating list,
# so unpatch removes the list too only then.
CTL_ID = "wingman-capture"


def is_ctl(f):
    c = f.get("content") if isinstance(f, dict) else None
    return isinstance(c, dict) and c.get("mod") == "wingman" and (c.get("props") or {}).get("role") == "capture"


def add_ctl(root, acts):
    fl = root.get("floating")
    if fl is not None and not isinstance(fl, list):
        print("NOTE the layout's floating is not a list; capture controller not added")
        return
    made = fl is None
    fl = fl if fl is not None else []
    if any(is_ctl(f) for f in fl):
        return
    if any(isinstance(f, dict) and f.get("id") == CTL_ID for f in fl):
        print("NOTE a floating block with id %s exists but is not Wingman's; skipped" % CTL_ID)
        return
    props = {"role": "capture", "added": True}
    if made:
        props["list_added"] = True
    fl.append({"id": CTL_ID, "content": {"mod": "wingman", "props": props}})
    root["floating"] = fl
    acts.append("add floating block %s (capture controller)" % CTL_ID)


def remove_ctl(root, acts):
    fl = root.get("floating")
    if not isinstance(fl, list):
        return
    keep = [f for f in fl if not is_ctl(f)]
    if len(keep) == len(fl):
        return
    made = any(((f.get("content") or {}).get("props") or {}).get("list_added") is True for f in fl if is_ctl(f))
    acts.append("remove floating block %s" % CTL_ID)
    if keep or not made:
        root["floating"] = keep
    else:
        del root["floating"]


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
        props = tabs["content"].get("props")
        if not isinstance(props, dict):
            props = tabs["content"]["props"] = {}
        props["replaces"] = "tabs"
        acts.append("point block %s at tabs-plus" % tabs.get("id"))
    if parent is not None and isinstance(parent.get("max"), (int, float)) and not isinstance(parent.get("max"), bool) \
            and parent["max"] < MAXPX:
        mark = next((c for c in stack["children"] if isinstance(c, dict) and is_wing(c)), None)
        if mark is not None:
            acts.append("raise max of %s from %s to %d" % (parent.get("id"), parent["max"], MAXPX))
            mark["content"].setdefault("props", {}).setdefault("max_was", parent["max"])
            parent["max"] = MAXPX
        else:
            print("NOTE max of %s left as it is: no Wingman block to keep the old value in" % parent.get("id"))
    add_ctl(root, acts)
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
        if "version" not in cf:
            # Herdr refuses a cloned_from without a version. The app's own layout.clone is preferred
            # (see layout_install); this is the offline fallback: the app version that last ran.
            try:
                v = json.load(open(os.path.join(os.path.dirname(here), "update-notes.json"), encoding="utf-8")).get("last_run")
            except Exception:
                v = None
            cf["version"] = v if isinstance(v, str) and v else "0.0.0"
            print("NOTE %s has no cloned_from.version to copy; wrote %s (the app's own clone is better: Duplicate layout)" % (cloned, cf["version"]))
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
    remove_ctl(root, acts)
    ids = [w[0] for w in WING]
    stack, parent = find_stack(root)
    # The max Wingman raised goes back, unless the person changed it since.
    if stack is not None and parent is not None:
        for c in stack["children"]:
            p = c.get("content", {}).get("props") if isinstance(c, dict) and is_wing(c) else None
            if isinstance(p, dict) and "max_was" in p:
                if parent.get("max") == MAXPX:
                    parent["max"] = p["max_was"]
                    acts.append("put the max of %s back to %s" % (parent.get("id"), p["max_was"]))
                break
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
        # Only a block Wingman switched (it kept the old mod in props.replaces) goes back.
        if n.get("type") == "block" and isinstance(c, dict) and c.get("mod") == "tabs-plus" \
                and isinstance(c.get("props"), dict) and c["props"].get("replaces") == "tabs":
            c["mod"] = "tabs"
            del c["props"]["replaces"]
            if not c["props"]:
                del c["props"]
            acts.append("point block %s back at tabs" % n.get("id"))
    for a in acts:
        print("ACT " + a)
    if not acts:
        return result("unchanged")
    if not dry:
        print("ACT back up to %s" % os.path.basename(backup(path, bak)))
        write(path, root, fmt)
    return result("changed")


def put_back(lst, removed, original):
    out = list(lst)
    for name in [n for n in original if n in removed]:
        if name in out:
            continue
        before = [n for n in original[: original.index(name)] if n in out]
        out.insert(out.index(before[-1]) + 1 if before else 0, name)
    return out


def keys(path, bak, dry):
    root, fmt = read(path)
    sec = root.get("mod:wingman")
    if not isinstance(sec, dict):
        return result("unchanged")
    mine = [k for k, v in sec.items() if isinstance(v, str) and v.startswith("wingman.")]
    if not mine:
        return result("unchanged")
    for k in mine:
        print("ACT remove binding %s from keys.json" % k)
        del sec[k]
    if not sec:
        del root["mod:wingman"]
    if not dry:
        print("ACT back up to %s" % os.path.basename(backup(path, bak)))
        write(path, root, fmt)
    return result("changed")


def settings(path, dry):
    if not os.path.isfile(path):
        return result("unchanged")
    root, fmt = read(path)
    if root.get("hideHerdrPanels") is not True:
        return result("unchanged")
    root["hideHerdrPanels"] = False
    print("ACT turn off \"Hide Herdr's Files and Changes buttons\" in Wingman's settings")
    if not dry:
        write(path, root, fmt)
    return result("changed")


def panels(home, bak, dry):
    path = os.path.join(home, "shared.json")
    if not os.path.isfile(path):
        return result("unchanged")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    st = data.get("wingman.panelsHidden")
    ok = lambda v: isinstance(v, list) and all(isinstance(x, str) for x in v)
    if not (isinstance(st, dict) and st.get("on") is True and ok(st.get("removed")) and ok(st.get("original"))):
        return result("unchanged")
    cur = data.get("workspace.panels")
    cur = cur if ok(cur) else ["files", "changes"]
    data["workspace.panels"] = put_back(cur, st["removed"], st["original"])
    data["wingman.panelsHidden"] = {"on": False, "removed": [], "original": []}
    print("ACT put back %s in workspace.panels" % ", ".join(st["removed"]) if st["removed"] else "ACT clear Wingman's panel record")
    if not dry:
        print("ACT back up to %s" % os.path.basename(backup(path, bak)))
        tmp = path + ".tmp-%d" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, path)
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
    elif cmd == "keys":
        keys(a[0], a[1], a[2] == "1")
    elif cmd == "settings":
        settings(a[0], a[1] == "1")
    elif cmd == "panels":
        panels(a[0], a[1], a[2] == "1")
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
    target="$name-copy"
    [ -f "$lay/$name-wingman.json" ] && [ ! -f "$lay/$target.json" ] && target="$name-wingman" # an earlier install's copy
    say "  active layout \"$name\" is shipped (read-only); using the copy \"$target\""
    case "$name" in *[!A-Za-z0-9._\ -]*) die "layout name \"$name\" has characters this installer won't pass on; rename the layout" ;; esac
    # Herdr's own clone first (it records cloned_from with the right version and switches to the copy).
    fresh=0
    if [ ! -f "$lay/$target.json" ] && [ "$dry" != 1 ]; then
      case "$(pylayout status "$lay/$name.json")" in
        stack=yes*) if app_do layout.clone "{\"name\":\"$name\"}" && [ -f "$lay/$target.json" ]; then fresh=1; say "  cloned with Herdr's layout.clone"; fi ;;
      esac
    fi
    if [ -f "$lay/$target.json" ]; then
      if [ "$fresh" = 1 ]; then bak=-; else bak="$lay/$target.json.bak-$ts"; fi
      show patch "$lay/$target.json" "$lay/$target.json" "$bak" "$dry" "$name"
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
  say "    - to the root's \"floating\" list, the capture controller:"
  say "        {\"id\":\"wingman-capture\",\"content\":{\"mod\":\"wingman\",\"props\":{\"role\":\"capture\"}}}"
  say "    - set the tabs block's \"content\":{\"mod\":\"tabs-plus\"}"
  say "    - raise \"max\" of the column holding the stack to 2400"
  note_next "Add the Wingman blocks to your layout by hand (see above)."
}

# Runs `herdr-app do NAME JSON` against the app that owns $home. HERDR_APP_BIN names the program
# (default herdr-app on PATH); with neither, nothing is run and the caller says what to do by hand.
app_do() {
  bin=${HERDR_APP_BIN:-}
  [ -n "$bin" ] || bin=$(command -v herdr-app 2>/dev/null) || return 1
  HERDR_APP_HOME="$home" "$bin" do "$@" >/dev/null 2>&1
}

switch_to() { # layout name
  if [ "$dry" = 1 ]; then act "switch to layout $1"; return; fi
  if app_do layout.switch "{\"name\":\"$1\"}"; then
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

# ---- keys, panel buttons ----
# Wingman writes its own "mod:wingman" section of keys.json while it runs, only where the key is
# free (it never replaces a binding that isn't Wingman's). Uninstall removes only those bindings.
keys_uninstall() {
  say "Keys"
  f="$home/keys.json"
  [ -f "$f" ] || { say "  no keys.json"; return; }
  show keys "$f" "$f.bak-$ts" "$dry"
  case "$res" in changed) note_change "Wingman's bindings removed from keys.json (backup: keys.json.bak-$ts)" ;; *) say "  no Wingman bindings in keys.json" ;; esac
}

# The setting "Hide Herdr's Files and Changes buttons" removed entries from workspace.panels. Turn
# it off through the running mod (it puts back exactly what it took); if the app isn't running or
# doesn't answer, restore shared.json directly.
panels_uninstall() {
  say "Panel buttons"
  show settings "$home/data/wingman/settings.json" "$dry"
  [ "$res" = changed ] && note_change "Wingman's panel-button setting turned off"
  if [ "$res" = changed ] && [ "$dry" != 1 ] && app_do wingman.settings; then
    say "  asked the running Wingman to put the buttons back"
    sleep 2
  fi
  show panels "$home" "$home/shared.json.bak-$ts" "$dry"
  case "$res" in
    changed) note_change "workspace.panels restored in shared.json"
             note_next "If Herdr is running, check Files and Changes are back in the tab bar; Herdr may rewrite shared.json from memory." ;;
    *) say "  nothing to put back" ;;
  esac
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
    panels_uninstall # first: it asks the running mod, which stops answering once its blocks leave the layout
    keys_uninstall
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
