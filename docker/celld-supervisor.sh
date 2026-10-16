#!/bin/sh
# Wait at least a lease lifetime after an unexpected exit, as celld requires.
set -u
child=''
stopping=0
stop() { stopping=1; if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null || true; fi; }
trap stop TERM INT
# A restarted container must also wait for its previous process lease to expire.
delay=$(node -e 'const ttl=Number(process.env.CELLD_TTL_MS||10000); const delay=Number(process.env.FOGD_RESTART_DELAY_SECONDS||15); if(!Number.isFinite(delay)||delay*1000<ttl)process.exit(1); console.log(delay)') || exit 1
sleep "$delay" &
child=$!
wait "$child"
while [ "$stopping" -eq 0 ]; do
  celld "$@" &
  child=$!
  wait "$child"
  code=$?
  if [ "$stopping" -eq 1 ]; then wait "$child" 2>/dev/null || true; exit 0; fi
  echo "celld exited ($code); waiting for lease expiry before restart" >&2
  sleep "$delay" &
  child=$!
  wait "$child"
done
