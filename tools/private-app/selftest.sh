#!/usr/bin/env bash
# Self-test of private-app, against the real app (WSL -> Windows).
#   tools/private-app/selftest.sh [--ref <git rev>]   (default HEAD)
# 1. no mod: start, status without errors, screenshot, stop, nothing left
# 2. Wingman as committed at <ref> (git archive, never the working tree): start with it,
#    status without errors, `check` passes, open it in a tab, screenshot, stop, nothing left
# Before and after: the person's own Herdr processes (recorded before anything starts) are all
# still alive. Instances are stopped on failure too.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
PA=$here/private-app
ref=HEAD
while [ $# -gt 0 ]; do
  case $1 in
    --ref) ref=${2:-}; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

# shellcheck source=private-app
. "$PA"
[ "$PLAT" = wsl ] || { echo "selftest: only WSL is supported yet" >&2; exit 2; }
plat init

fails=0
ok() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fails=$((fails + 1)); }
check() { local what=$1; shift; if "$@"; then ok "$what"; else bad "$what"; fi; }

tmp=$(mktemp -d)
started=()
cleanup() {
  set +e
  local n
  for n in "${started[@]}"; do
    [ -f "$PA_BASE/$n/instance.json" ] && { echo "cleanup: stopping $n"; "$PA" stop "$n"; }
  done
  rm -rf -- "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# The person's own Herdr: every herdr-app.exe and herdr-core.exe now ("pid ticks name").
# hc.exe is left out: the person's mods start short-lived hc.exe calls all the time.
owner_snapshot() {
  plat procs | awk -F'\t' '$3 == "herdr-app.exe" || $3 == "herdr-core.exe" { print $1, $4, $3 }'
}
alive_set() { plat procs | awk -F'\t' '{ print $1, $4 }'; }
owner=$(owner_snapshot)
owner_apps=$(awk '$3 == "herdr-app.exe" { print $1 }' <<<"$owner" | tr '\n' ' ')
echo "owner's Herdr processes before: $(wc -l <<<"$owner") (herdr-app.exe pid(s): ${owner_apps:-none})"
owner_alive() {
  local now p t n missing=0
  now=$(alive_set)
  while read -r p t n; do
    [ -n "$p" ] || continue
    grep -qx "$p $t" <<<"$now" || { echo "  gone: $n pid $p"; missing=1; }
  done <<<"$owner"
  return $missing
}

no_errors() { [ "$("$PA" status "$1" | sed -n 's/^errors //p')" = "[]" ]; }

# Stop an instance and check nothing of it is left: its processes (by pid and creation time),
# its session's holders, its home and its core state folder.
stop_and_verify() {
  local n=$1 procs root state now p nm t why left=0
  procs=$("$PA" procs "$n")
  root=$PA_BASE/$n
  state=$(jfield "$root/instance.json" core_state)
  "$PA" stop "$n"
  now=$(alive_set)
  while IFS=$'\t' read -r p nm t why; do
    [ -n "$p" ] || continue
    if grep -qx "$p $t" <<<"$now"; then echo "  left running: $nm pid $p ($why)"; left=1; fi
  done <<<"$procs"
  check "$n: none of its $(wc -l <<<"$procs") processes left" [ $left = 0 ]
  I_SESSION=pa-$n
  check "$n: no holders of session pa-$n" [ -z "$(plat holders)" ]
  check "$n: home removed" [ ! -e "$root" ]
  check "$n: core state removed" [ ! -e "$state" ]
}

# ---- 1. no mod ----------------------------------------------------------------------------
n1=st-$(date +%H%M%S)-a
started+=("$n1")
echo "== $n1: no mod"
"$PA" start --name "$n1"
check "$n1: app alive" "$PA" alive "$n1"
check "$n1: status has no errors" no_errors "$n1"
shots=$PA_BASE/selftest-shots # beside the instances (not one of them); kept for a look
mkdir -p "$shots"
shot1=$("$PA" shot "$n1" "$shots/$n1.png") && check "$n1: screenshot $shot1" [ -s "$shot1" ]
stop_and_verify "$n1"
check "owner's Herdr alive after $n1" owner_alive

# ---- 2. Wingman ---------------------------------------------------------------------------
n2=st-$(date +%H%M%S)-w
started+=("$n2")
echo "== $n2: Wingman at $ref"
git -C "$repo" archive "$ref" wingman/mods/wingman | tar -x -C "$tmp"
"$PA" start --name "$n2" --mod "$tmp/wingman/mods/wingman"
home_w=$(jfield "$PA_BASE/$n2/instance.json" home_native)
check "$n2: app alive" "$PA" alive "$n2"
check "$n2: status has no errors" no_errors "$n2"
check "$n2: check passes for the mod" "$PA" app "$n2" check "$home_w\\mods\\wingman"
root_w=$(plat path_native "$PA_BASE/$n2")
"$PA" app "$n2" do space.new "$(py -c 'import json,sys; print(json.dumps({"name":"selftest","folder":sys.argv[1]}))' "$root_w")" >/dev/null
"$PA" app "$n2" do tab.new '{"mod":"wingman"}' >/dev/null
check "$n2: app answers after opening Wingman" "$PA" wait "$n2" 15 app status
check "$n2: status has no errors with Wingman shown" no_errors "$n2"
check "$n2: app still alive" "$PA" alive "$n2"
shot2=$("$PA" shot "$n2" "$shots/$n2.png") && check "$n2: screenshot $shot2" [ -s "$shot2" ]
crash=$("$PA" crashinfo "$n2" | awk '/^== tail/ { exit } NR > 1')
check "$n2: no crash events for its app" [ -z "$crash" ]
stop_and_verify "$n2"
if owner_alive; then ok "owner's Herdr alive after $n2 (Wingman)"; else bad "owner's Herdr NOT all alive after $n2 (Wingman); not restarted"; fi

echo "== $([ $fails = 0 ] && echo "selftest passed" || echo "selftest FAILED: $fails")"
[ $fails = 0 ]
