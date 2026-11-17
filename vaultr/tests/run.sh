#!/bin/sh
# Runs the Vaultr tests: sh vaultr/tests/run.sh [file ...]
# They cover the two modules that need no Herdr: md.js and vault.js.
cd "$(dirname "$0")" || exit 1
[ $# -gt 0 ] || set -- ./*.test.mjs
exec node --test "$@"
