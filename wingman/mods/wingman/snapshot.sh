#!/bin/sh
# Snapshots a repo's working tree as a git tree object without touching the real
# index, stash or branch: copies the index to a temp file, stages everything into
# the copy (so unchanged files are not re-hashed), and prints the tree id.
# Usage: snapshot.sh <git-dir> <work-tree>
set -e
store="$1/wingman"
mkdir -p "$store/baselines"
# Each run has its own index copy (snap.<pid>.index), so two runs never share one, and it goes
# when the run ends. A run killed outright leaves its copy (and git's .lock beside it): the next
# run removes those of runs that are gone, and the single snap.index of older versions.
for f in "$store"/snap.*.index "$store"/snap.*.index.lock; do
  [ -e "$f" ] || continue
  pid=${f##*/snap.}; pid=${pid%%.*}
  case $pid in *[!0-9]*|'') continue ;; esac
  kill -0 "$pid" 2>/dev/null || rm -f "$f"
done
rm -f "$store/snap.index" "$store/snap.index.lock"
tmp="$store/snap.$$.index"
trap 'rm -f "$tmp" "$tmp.lock"' EXIT
trap 'exit 1' HUP INT TERM
rm -f "$tmp" "$tmp.lock"
# -p keeps the index's time: git trusts a matching stat only for entries older than the index
# file, so a fresh copy (newer than every entry) would hide a same-size edit made in the same
# second as the entry ("racily clean"), and that file would never be captured.
# git replaces its index by rename, and a copy that races a commit or add running in the repo can fail
# ("replaced while being copied"): a few tries, then fail.
if [ -f "$1/index" ]; then
  n=0
  until cp -p "$1/index" "$tmp"; do n=$((n+1)); [ "$n" -lt 5 ] || exit 1; sleep 0.05; done
fi
cd "$2"
# No hook or fsmonitor may run for a snapshot (post-index-change fires on the copy's write, core.fsmonitor on the scan).
# --ignore-errors: a file git can't read (permissions, a filter that fails) is left out, or keeps its indexed
# content, instead of losing the whole snapshot; git then exits 1 after indexing everything else, which is fine.
# Any other code (128: a corrupt index, a lock) is a real failure.
# A filter marked required (git-lfs, say) that can't run makes add -A fatal for the whole tree, which --ignore-errors
# doesn't cover: drop the flag for this run, so the file is taken as it is on disk.
set --
for k in $(GIT_INDEX_FILE="$tmp" git config --name-only --get-regexp '^filter\..*\.required$' 2>/dev/null); do set -- "$@" -c "$k=false"; done
nohooks="$store/nohooks"
rc=0
GIT_INDEX_FILE="$tmp" git --no-optional-locks -c core.safecrlf=false -c core.fsmonitor=false -c "core.hooksPath=$nohooks" "$@" add -A --ignore-errors || rc=$?
[ "$rc" -le 1 ] || exit "$rc"
GIT_INDEX_FILE="$tmp" git -c core.fsmonitor=false -c "core.hooksPath=$nohooks" "$@" write-tree
