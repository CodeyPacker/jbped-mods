#!/bin/sh
# Runs the Wranglr mod tests: sh wranglr/tests/run.sh [name ...]
here=$(cd "$(dirname "$0")" && pwd)
home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT INT TERM
mkdir -p "$home/home"
export WRANGLR_TEST_HOME="$home"
if [ $# -gt 0 ]; then names="$*"; else names=$(cd "$here" && ls *.test.mjs | sed 's/\.test\.mjs$//'); fi
fail=0
cd "$here"
for n in $names; do
  if out=$(node --import ./register.mjs --test "$n.test.mjs" 2>&1); then echo "ok $n"
  else echo "FAIL $n"; echo "$out"; fail=1; fi
done
exit $fail
