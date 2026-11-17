#!/bin/sh
# Runs the Brunr tests: sh brunr/tests/run.sh [file ...]
# The modules under test import nothing from Herdr, so no shim is registered yet.
cd "$(dirname "$0")" || exit 1
[ $# -gt 0 ] || set -- ./*.test.mjs
exec node --test "$@"
