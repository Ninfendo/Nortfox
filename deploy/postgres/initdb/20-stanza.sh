#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# The first start of an install only, after 10-roles.sh. The image's setup
# server runs with the compose file's command, so it already archives WAL
# through pgBackRest. This script checks that it does, and that an off-site
# repository that is a folder is a mount of its own. It makes the stanza in
# both repositories, and then has pgBackRest prove that a WAL segment reaches
# both. Then it writes the file nortfox-first-start-done in the data folder,
# which the compose file's health check needs, and takes the first full
# backup to each repository, so that the WAL archive has a backup to replay
# onto from the first start on. Until both backups are taken, the file
# nortfox-first-backups-pending on the data volume, outside the data folder,
# keeps the health check failing. Any failure stops the first start without
# the first file, and a first start that is killed during the backups leaves
# the second. The image skips its setup on a restart, so such a first start
# never becomes healthy and the migrations never run: an install never runs
# without its archive and its first backups. deploy/README.md says what to do
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

# An off-site repository that is a folder, of type posix or cifs, must be a
# mount of its own. Without one, the folder is the image's own, in the
# container's layer, on the same disk as the data: its backups would not be
# kept apart, and they would go when the container is made again.
case "${PGBACKREST_REPO2_TYPE:-}" in
  posix | cifs)
    if ! mountpoint -q -- "${PGBACKREST_REPO2_PATH:-}"; then
      echo "20-stanza: the off-site repository is of type ${PGBACKREST_REPO2_TYPE}, but nothing is mounted at its path, ${PGBACKREST_REPO2_PATH:-}. Its backups would stay in the container, on the same disk as the data. Mount the off-site folder there, as deploy/README.md says." >&2
      exit 1
    fi
    ;;
esac

pgbackrest --stanza=nortfox stanza-create
# From here on, a failed first start leaves the stanza in the off-site
# repository, which docker compose down --volumes does not remove. This line
# in the log tells the operator so (deploy/README.md).
echo "20-stanza: made the stanza nortfox in both repositories."
if ! pgbackrest --stanza=nortfox check; then
  echo "20-stanza: pgBackRest's check failed after the stanza was made in both repositories. Before the next first start, empty the off-site repository's path too. deploy/README.md says how." >&2
  exit 1
fi

# The mark that the first full backups are still to come. It is on the data
# volume but outside the data folder, so no backup holds it and a restore
# never brings it back. It goes only once both backups are taken, so a first
# start that is killed during them never becomes healthy.
touch -- /var/lib/postgresql/nortfox-first-backups-pending
# The mark of a finished first start. It is in the data folder, so the first
# full backups below hold it, and a restore from them brings it back.
touch -- "$PGDATA/nortfox-first-start-done"

# The first full backup to each repository, while the database is still
# empty, so it is quick. Every later write is in the WAL archive, and a
# restore replays it onto this backup. When a backup fails, the mark goes
# again, so the failed first start never becomes healthy.
if ! pgbackrest --stanza=nortfox --repo=1 --type=full backup ||
  ! pgbackrest --stanza=nortfox --repo=2 --type=full backup; then
  rm -f -- "$PGDATA/nortfox-first-start-done"
  echo "20-stanza: the first full backup failed after the stanza was made in both repositories. Before the next first start, empty the off-site repository's path too. deploy/README.md says how." >&2
  exit 1
fi
rm -f -- /var/lib/postgresql/nortfox-first-backups-pending

echo "20-stanza: the stanza nortfox is made, WAL reaches both repositories, and each holds a full backup."
