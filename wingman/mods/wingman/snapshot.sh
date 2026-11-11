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
if [ -f "$1/index" ]; then cp -p "$1/index" "$tmp"; fi
cd "$2"
GIT_INDEX_FILE="$tmp" git --no-optional-locks add -A
GIT_INDEX_FILE="$tmp" git write-tree
