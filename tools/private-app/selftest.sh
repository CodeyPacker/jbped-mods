#!/usr/bin/env bash
# Self-test of private-app, against the real app (WSL -> Windows).
#   tools/private-app/selftest.sh [--ref <git rev>] [--only N[,N...]]   (default HEAD, every part)
# 1. no mod: start, status without errors, screenshot, stop, nothing left
# 2. Wingman as committed at <ref> (git archive, never the working tree): start with it,
#    status without errors, `check` passes, open it in a tab, screenshot, stop, nothing left
# 3. two starts at the same moment: each records its own app (different pids), both alive, both
#    stop with nothing left
# 4. input: the pa-probe mod gets click (left, right, double, shift), key, type, wheel and drag;
#    the foreground window stays; a record with a wrong app creation time is refused, sending nothing
# Before and after: the person's own Herdr processes (recorded before anything starts) are all
# still alive. Instances are stopped on failure too.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
PA=$here/private-app
ref=HEAD only=""
while [ $# -gt 0 ]; do
  case $1 in
    --ref) ref=${2:-}; shift ;;
    --only) only=${2:-}; shift ;;
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
# `herdr-core.exe exec` is left out too: one-shot calls the person's mods run (seen: a docker poll every few seconds).
owner_snapshot() {
  win_ps "Get-CimInstance Win32_Process -Filter \"Name='herdr-app.exe' or Name='herdr-core.exe'\" | Where-Object { -not (\$_.Name -eq 'herdr-core.exe' -and \$_.CommandLine -match '\\sexec\\s') } | ForEach-Object { '{0} {1} {2}' -f \$_.ProcessId,\$_.CreationDate.ToUniversalTime().Ticks,\$_.Name }" | grep -E '^[0-9]+ [0-9]+ herdr-(app|core)\.exe$' || true
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

want() { [ -z "$only" ] || [[ ",$only," == *",$1,"* ]]; }
not_brought_forward() { [ "$2" != "$3" ] || [ "$1" = "$3" ]; } # before after app: the app came to the front only if it was there
differ() { [ -n "$1" ] && [ "$1" != "$2" ]; }
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
if want 1; then
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
fi

# ---- 2. Wingman ---------------------------------------------------------------------------
if want 2; then
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
fi

# ---- 3. two starts at the same moment -----------------------------------------------------
if want 3; then
# Each must find its own app (the start lock), never the other's, and stop cleanly.
n3a=st-$(date +%H%M%S)-c1 n3b=st-$(date +%H%M%S)-c2
started+=("$n3a" "$n3b")
echo "== $n3a + $n3b: started together"
"$PA" start --name "$n3a" >"$tmp/$n3a.out" 2>&1 & pa=$!
"$PA" start --name "$n3b" >"$tmp/$n3b.out" 2>&1 & pb=$!
ra=0 rb=0; wait "$pa" || ra=$?; wait "$pb" || rb=$?
check "$n3a: started (exit $ra; $(tail -1 "$tmp/$n3a.out"))" [ "$ra" = 0 ]
check "$n3b: started (exit $rb; $(tail -1 "$tmp/$n3b.out"))" [ "$rb" = 0 ]
if [ "$ra" = 0 ] && [ "$rb" = 0 ]; then
  pid_a=$(jfield "$PA_BASE/$n3a/instance.json" app_pid) pid_b=$(jfield "$PA_BASE/$n3b/instance.json" app_pid)
  check "$n3a and $n3b recorded different apps ($pid_a, $pid_b)" differ "$pid_a" "$pid_b"
  check "$n3a: app alive" "$PA" alive "$n3a"
  check "$n3b: app alive" "$PA" alive "$n3b"
  check "$n3a: status has no errors" no_errors "$n3a"
  check "$n3b: status has no errors" no_errors "$n3b"
fi
for n in "$n3a" "$n3b"; do [ -f "$PA_BASE/$n/instance.json" ] && stop_and_verify "$n"; done
check "owner's Herdr alive after the concurrent starts" owner_alive
fi

# ---- 4. input: click, drag, wheel, key, type into the probe mod ----------------------------
if want 4; then
# pa-probe fills the window in four equal bands (button, text box, wheel area, pad) and writes
# every event to <home>/data/pa-probe.json. Positions are window px read from the probe itself.
n4=st-$(date +%H%M%S)-i
started+=("$n4")
echo "== $n4: input to the probe mod"
"$PA" start --name "$n4" --mod "$here/pa-probe" --layout "$here/probe.json"
probe=$PA_BASE/$n4/home/data/pa-probe.json
pj() { py -c 'import json,sys
d=json.load(open(sys.argv[1]))
print(eval(sys.argv[2], {"d": d}))' "$probe" "$1" 2>/dev/null; }
# the probe writes after each event; wait for the field to say what is expected
expect() { local what=$1 expr=$2 want=$3 got="" i; for i in $(seq 1 20); do got=$(pj "$expr"); [ "$got" = "$want" ] && break; sleep 0.25; done
  check "$n4: $what (got '$got', want '$want')" [ "$got" = "$want" ]; }
# The pid owning the foreground window (the person may switch windows meanwhile: only "our input
# brought the private window to the front" is a failure).
foreground() { win_ps 'Add-Type -Name F -Namespace PA -MemberDefinition '"'"'[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p);'"'"'; $p = 0; [void][PA.F]::GetWindowThreadProcessId([PA.F]::GetForegroundWindow(), [ref]$p); $p' || echo none; }
plat_input_info() { ( load_instance "$1"; plat input -Op info ); }
fg_before=$(foreground)
size=$(py -c 'import struct,sys; d=open(sys.argv[1],"rb").read(24); print(*struct.unpack(">II", d[16:24]))' "$("$PA" shot "$n4" "$tmp/probe.png")")
read -r W H <<<"$size"
dpi=$(plat_input_info "$n4" | sed -n 's/.* dpi \([0-9]*\)$/\1/p')
check "$n4: window info (client ${W}x${H}, dpi $dpi)" [ -n "$dpi" ]
# A press near the bottom gives the pad the keyboard and records its bounds (logical px).
"$PA" click "$n4" $((W / 2)) $((H - 20)) >/dev/null
expect "pad press recorded with its bounds" '[e["ev"] for e in d["drag"][-2:]], d["pad"] is not None' "(['down', 'up'], True)"
read -r px py pw ph <<<"$(pj '" ".join(str(d["pad"][k]) for k in ("x","y","width","height"))')"
phys() { py -c 'import sys; print(round(float(sys.argv[1]) * int(sys.argv[2]) / 96))' "$1" "$dpi"; }
band_y() { phys "$(py -c 'import sys; print(float(sys.argv[1]) - (3 - int(sys.argv[3])) * float(sys.argv[2]) + float(sys.argv[2]) / 2)' "$py" "$ph" "$1")"; }
cx=$((W / 2)) yb=$(band_y 0) yi=$(band_y 1) yw=$(band_y 2) yp=$(band_y 3)
"$PA" click "$n4" "$cx" "$yb" >/dev/null
expect "click: one left click" 'd["clicks"], d["left"]' "(1, 1)"
"$PA" click "$n4" "$cx" "$yb" --button right >/dev/null
expect "click --button right" 'd["right"]' 1
"$PA" click "$n4" "$cx" "$yb" --double >/dev/null
expect "click --double: click_count 2" 'd["maxCount"]' 2
"$PA" click "$n4" "$cx" "$yp" >/dev/null
"$PA" key "$n4" ctrl-s >/dev/null
expect "key ctrl-s" 'd["keys"][-1]["keystroke"]' ctrl-s
"$PA" key "$n4" alt-shift-f >/dev/null
expect "key alt-shift-f" 'd["keys"][-1]["keystroke"]' alt-shift-f
"$PA" key "$n4" escape >/dev/null
expect "key escape" 'd["keys"][-1]["keystroke"]' escape
"$PA" click "$n4" "$cx" "$yi" >/dev/null
"$PA" type "$n4" 'Hi "there"; $(x) ö' >/dev/null
expect "type into a text box" 'd["input"]' 'Hi "there"; $(x) ö'
"$PA" wheel "$n4" "$cx" "$yw" -240 >/dev/null
expect "wheel -240: two steps down" '[w["dy"] < 0 for w in d["wheel"]]' "[True, True]"
"$PA" drag "$n4" $((cx - 200)) "$yp" $((cx + 200)) "$((yp + 10))" >/dev/null
expect "drag: press, moves, release to the right" '[e["ev"] for e in d["drag"][-3:]], d["drag"][-1]["at"]["x"] > [e for e in d["drag"] if e["ev"] == "down"][-1]["at"]["x"]' "(['move', 'move', 'up'], True)"
"$PA" click "$n4" "$cx" "$yp" --mods shift >/dev/null
expect "click --mods shift" 'd["drag"][-2]["shift"]' True
app4=$(jfield "$PA_BASE/$n4/instance.json" app_pid) fg_after=$(foreground)
check "$n4: input did not bring the private window to the front (foreground pid before $fg_before, after $fg_after)" \
  not_brought_forward "$fg_before" "$fg_after" "$app4"
# A record whose app creation time is off by one tick: nothing is sent, exit non-zero.
nf=$n4-x
mkdir -p "$PA_BASE/$nf/home"
py -c 'import json,sys
d=json.load(open(sys.argv[1])); d.update(name=sys.argv[3], session="pa-"+sys.argv[3], root=sys.argv[4], home=sys.argv[4]+"/home", home_native=sys.argv[5], app_ticks=d["app_ticks"]+1)
open(sys.argv[2],"w").write(json.dumps(d))' "$PA_BASE/$n4/instance.json" "$PA_BASE/$nf/instance.json" "$nf" "$PA_BASE/$nf" "$(plat path_native "$PA_BASE/$nf/home")"
seq_before=$(pj 'd["seq"]')
if "$PA" click "$nf" "$cx" "$yb" 2>/dev/null; then bad "$nf: click with a wrong creation time was not refused"; else ok "$nf: click with a wrong creation time refused"; fi
if "$PA" type "$nf" zzz 2>/dev/null; then bad "$nf: type with a wrong creation time was not refused"; else ok "$nf: type with a wrong creation time refused"; fi
# and wininput.ps1's own check, without private-app's
if ( load_instance "$nf"; plat input -Op click -X "$cx" -Y "$yb" ) 2>/dev/null; then bad "$nf: wininput.ps1 did not refuse"; else ok "$nf: wininput.ps1 refuses a wrong creation time"; fi
sleep 1
check "$nf: the probe got nothing" [ "$(pj 'd["seq"]')" = "$seq_before" ]
rm -rf -- "${PA_BASE:?}/$nf"
stop_and_verify "$n4"
check "owner's Herdr alive after the input test" owner_alive
fi

echo "== $([ $fails = 0 ] && echo "selftest passed" || echo "selftest FAILED: $fails")"
[ $fails = 0 ]
