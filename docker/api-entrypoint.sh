#!/bin/sh
set -eu
npx drizzle-kit migrate
mkdir -p /data/media
exec "$@"
