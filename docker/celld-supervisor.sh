#!/bin/sh
# Wait at least a lease lifetime after an unexpected exit, as celld requires.
set -u
child=''
stopping=0
stop() { stopping=1; if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null || true; fi; }
trap stop TERM INT
while [ "$stopping" -eq 0 ]; do
  celld "$@" &
  child=$!
  wait "$child"
  code=$?
  if [ "$stopping" -eq 1 ]; then wait "$child" 2>/dev/null || true; exit 0; fi
  echo "celld exited ($code); waiting for lease expiry before restart" >&2
  sleep "${FOGD_RESTART_DELAY_SECONDS:-15}" &
  child=$!
  wait "$child"
done
