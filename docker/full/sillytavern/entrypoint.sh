#!/bin/sh
set -e
bash /repo/setup.sh --st-path /home/node/app
exec "$@"
