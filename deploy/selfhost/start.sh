#!/bin/bash
set -eu
# The backend fetches its own JWKS. Keep loopback ports identical inside/outside
# the container; Docker's usual 3411:3211 mapping makes that fetch unreachable.
sed -e "s/--port 3210/--port ${FNFE_LOCAL_CLOUD_PORT}/" \
    -e "s/--site-proxy-port 3211/--site-proxy-port ${FNFE_LOCAL_SITE_PORT}/" \
    ./run_backend.sh > /tmp/fnfe-run-backend.sh
exec bash /tmp/fnfe-run-backend.sh
