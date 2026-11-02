#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# The first start of an install only, after 10-roles.sh. The image's setup
# server runs with the compose file's command, so it already archives WAL
# through pgBackRest. This script checks that it does, makes the stanza in
# both repositories, and then has pgBackRest prove that a WAL segment reaches
# both. Its last step writes the file nortfox-first-start-done in the data
# folder, which the compose file's health check needs. Any failure stops the
# first start before that, and the image skips its setup on a restart, so a
# failed first start never becomes healthy and the migrations never run: an
# install never runs without its archive. deploy/README.md says what to do
# then.
set -euo pipefail

psql=(psql --no-psqlrc --set ON_ERROR_STOP=1 --tuples-only --no-align --username "${POSTGRES_USER:-postgres}" --dbname postgres)

# Fails unless the server runs with the setting $1 at the value $2.
expect_setting() {
  local value
  value=$("${psql[@]}" --command "SHOW $1")
  if [[ "$value" != "$2" ]]; then
    echo "20-stanza: the server runs with $1 = '$value', not '$2'. Start it with the command in deploy/compose.yaml." >&2
    exit 1
  fi
}

expect_setting wal_level replica
expect_setting archive_mode on
expect_setting archive_command "pgbackrest --stanza=nortfox archive-push %p"
expect_setting archive_timeout 1min

pgbackrest --stanza=nortfox stanza-create
pgbackrest --stanza=nortfox check

# The mark of a finished first start. It is in the data folder, so a full
# backup holds it and a restore brings it back.
touch -- "$PGDATA/nortfox-first-start-done"

echo "20-stanza: the stanza nortfox is made, and WAL reaches both repositories."
