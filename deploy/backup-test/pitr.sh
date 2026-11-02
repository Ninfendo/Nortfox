#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# The point-in-time restore test (docs/decisions/0007-self-hosting-and-backups.md).
# It runs the install's own compose file, with backup-test/compose.yaml on
# top: a project of its own, made-up test secrets in a temporary folder, and
# a second local volume as the off-site repository. Then it checks:
#
# - a first start that fails, here because the off-site repository cannot be
#   written, never makes PostgreSQL healthy, also after Docker restarts it and
#   the image skips its setup, so the migrate step never runs;
# - on the running stack: PostgreSQL archives WAL through pgBackRest, with
#   archive_timeout 1min; the migrate step exited 0, and the owner role
#   applied every migration and owns every table; pgBackRest holds a full
#   backup and the WAL archive in both repositories;
# - write 1, then the time T, then write 2: a restore to T from repo1 gives
#   write 1 and not write 2, and so does a restore to T from repo2. Each
#   restore reads its backup and its WAL from its own repository only. T
#   falls in a later whole second than either backup's stop, as a restore to
#   a time needs.
#
# The containers, the volumes and the secrets go when the test ends, also when
# it fails. Run it with `pnpm backup:test`. It needs Docker with Compose v2,
# and nothing that runs as the project nortfox-backup-test.
set -euo pipefail

# Git Bash on Windows: pass every argument to docker as written. Paths go to
# docker through native() below.
export MSYS_NO_PATHCONV=1
# The test sets the off-site repository and the secrets itself.
unset NORTFOX_REPO2_TYPE NORTFOX_REPO2_PATH NORTFOX_TEST_SECRETS

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(cd -- "$here/../.." && pwd)
project=nortfox-backup-test

# A path in the form docker takes: on Windows, a Windows path.
native() {
  if command -v cygpath > /dev/null 2>&1; then
    cygpath --mixed -- "$1"
  else
    printf '%s\n' "$1"
  fi
}

work=$(mktemp -d)
mkdir "$work/secrets"

# The variables of the stack: test.env, or broken.env for the failed first start.
env_file=$work/test.env

compose() {
  docker compose --project-name "$project" --env-file "$(native "$env_file")" \
    --file "$(native "$root/deploy/compose.yaml")" --file "$(native "$here/compose.yaml")" "$@"
}

cleanup() {
  local status=$?
  if ((status != 0)); then
    echo "pitr: FAILED. The last lines of the stack's logs:" >&2
    compose logs --no-color --tail 100 postgres migrate >&2 || true
  fi
  compose down --volumes --remove-orphans > /dev/null 2>&1 || true
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT

fail() {
  echo "pitr: $*" >&2
  exit 1
}
step() { echo "pitr: $*"; }

# Fails unless $2, what was found, is $3; $1 says what it is.
expect() {
  if [[ "$2" != "$3" ]]; then
    fail "$1 is '$2', not '$3'."
  fi
  echo "pitr: ok, $1 is '$3'."
}

# SQL from stdin, as the role $1, in the database nortfox, over the socket.
sql() {
  compose exec -T --user postgres postgres \
    psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --tuples-only --no-align --username "$1" --dbname nortfox
}

backrest() {
  compose exec -T --user postgres postgres pgbackrest --stanza=nortfox "$@"
}

# The test secrets: made-up passwords, and the off-site repository's options,
# which a local volume does not need.
for name in postgres-password owner-password app-password; do
  od -An -N16 -tx1 /dev/urandom | tr -d ' \n' > "$work/secrets/$name"
done
cat > "$work/secrets/repo2.conf" << 'EOF'
# The restore test's off-site repository is a local volume: its type and path
# are all it needs.
[global]
EOF
# Readable inside the containers, whatever user runs them. The folder itself
# stays the test's own.
chmod 0644 "$work/secrets"/*
cat > "$work/test.env" << EOF
NORTFOX_TEST_SECRETS=$(native "$work/secrets")
NORTFOX_REPO2_TYPE=posix
NORTFOX_REPO2_PATH=/var/lib/pgbackrest-offsite
EOF

# The same, with an off-site repository that the user postgres cannot make.
cat > "$work/broken.env" << EOF
NORTFOX_TEST_SECRETS=$(native "$work/secrets")
NORTFOX_REPO2_TYPE=posix
NORTFOX_REPO2_PATH=/srv/offsite-not-writable
EOF

step "a first start that fails: the off-site repository cannot be written."
env_file=$work/broken.env
compose down --volumes --remove-orphans > /dev/null 2>&1 || true
compose up --detach --build postgres
broken=$(compose ps --all --quiet postgres)
# 20-stanza.sh fails, the container stops, and Docker starts it again. The
# image then skips its setup, and PostgreSQL answers over TCP.
answers=no
for _ in $(seq 180); do
  if (($(docker inspect --format '{{.RestartCount}}' "$broken") >= 1)) &&
    compose exec -T postgres pg_isready --quiet --host 127.0.0.1 --username postgres --dbname nortfox 2> /dev/null; then
    answers=yes
    break
  fi
  sleep 1
done
expect "PostgreSQL answering after a restart that skipped the failed setup" "$answers" yes
logs=$(compose logs --no-color postgres)
grep --quiet "Skipping initialization" <<< "$logs" || fail "the restart did not skip the setup."
# Some health checks later, it is still not healthy, so nothing that waits
# for it, such as the migrate step, starts.
sleep 15
health=$(docker inspect --format '{{.State.Health.Status}}' "$broken")
if [[ "$health" == healthy ]]; then
  fail "PostgreSQL is healthy after a failed first start."
fi
step "ok, after a failed first start PostgreSQL is $health, not healthy."
compose down --volumes --remove-orphans > /dev/null 2>&1
env_file=$work/test.env

step "building and starting the stack."
compose down --volumes --remove-orphans > /dev/null 2>&1 || true
compose up --detach --build

migrate=$(compose ps --all --quiet migrate)
for _ in $(seq 300); do
  if [[ "$(docker inspect --format '{{.State.Status}}' "$migrate")" == exited ]]; then
    break
  fi
  sleep 1
done
expect "the migrate step's state" "$(docker inspect --format '{{.State.Status}}' "$migrate")" exited
expect "the migrate step's exit code" "$(docker inspect --format '{{.State.ExitCode}}' "$migrate")" 0

step "checking the running stack."
expect "wal_level" "$(sql postgres <<< 'SHOW wal_level')" replica
expect "archive_mode" "$(sql postgres <<< 'SHOW archive_mode')" on
expect "archive_timeout" "$(sql postgres <<< 'SHOW archive_timeout')" 1min
expect "archive_command" "$(sql postgres <<< 'SHOW archive_command')" "pgbackrest --stanza=nortfox archive-push %p"

migrations=("$root"/db/migrations/*.sql)
expect "the migrations applied, and who applied them" \
  "$(sql postgres <<< "SELECT count(*) || ' by ' || string_agg(DISTINCT applied_by, ', ') FROM meta.schema_migrations")" \
  "${#migrations[@]} by nortfox_owner"
expect "the owner of the database nortfox" \
  "$(sql postgres <<< "SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_catalog.pg_database WHERE datname = 'nortfox'")" \
  nortfox_owner
tables=$(sql postgres << 'SQL'
SELECT count(*) FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname IN ('ledger', 'audit', 'meta') AND c.relkind IN ('r', 'p')
SQL
)
if ((tables < 10)); then
  fail "the database holds $tables tables in ledger, audit and meta."
fi
expect "what in ledger, audit and meta is not owned by nortfox_owner" "$(sql postgres << 'SQL'
SELECT coalesce(string_agg(what, ', ' ORDER BY what), 'nothing') FROM (
  SELECT 'schema ' || n.nspname || ' (' || pg_catalog.pg_get_userbyid(n.nspowner) || ')' AS what
  FROM pg_catalog.pg_namespace AS n
  WHERE n.nspname IN ('ledger', 'audit', 'meta') AND pg_catalog.pg_get_userbyid(n.nspowner) <> 'nortfox_owner'
  UNION ALL
  SELECT c.oid::pg_catalog.regclass::text || ' (' || pg_catalog.pg_get_userbyid(c.relowner) || ')'
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('ledger', 'audit', 'meta') AND pg_catalog.pg_get_userbyid(c.relowner) <> 'nortfox_owner'
) AS found
SQL
)" nothing
step "$tables tables, all owned by nortfox_owner."

step "a full backup to each repository."
backrest --repo=1 --type=full backup
backrest --repo=2 --type=full backup
info=$(backrest --log-level-console=warn info)
echo "$info"
grep --quiet --line-regexp '    status: ok' <<< "$info" || fail "pgbackrest info does not say status: ok."
for repo in 1 2; do
  grep --quiet "repo$repo: backup" <<< "$info" || fail "pgbackrest info shows no backup in repo$repo."
done
step "ok, pgbackrest info shows the stanza ok, with a full backup in repo1 and in repo2."

# pgBackRest keeps a backup's stop time in whole seconds, and a restore to a
# time takes only a backup that stopped in an earlier whole second than the
# target. So T must fall in a later second than the newest backup's stop:
# wait until PostgreSQL's clock, which gives T, is past that second.
newest_stop=$(backrest --log-level-console=warn --output=json info | grep --only-matching --extended-regexp '"stop":[0-9]+' | cut -d: -f2 | sort -n | tail -n 1 || true)
[[ "$newest_stop" =~ ^[0-9]+$ ]] || fail "pgbackrest info gave no stop time for a backup."
past_stop=no
for _ in $(seq 30); do
  if (($(sql postgres <<< 'SELECT floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint') > newest_stop)); then
    past_stop=yes
    break
  fi
  sleep 1
done
expect "PostgreSQL's clock past the second in which the newest backup stopped" "$past_stop" yes

# Made-up companies and actor. The organisation numbers are on the fixture
# guard's list of test values.
company_1=6f1d2a40-3b5c-4e7d-8a9b-0c1d2e3f4a51
company_2=6f1d2a40-3b5c-4e7d-8a9b-0c1d2e3f4a52
company_3=6f1d2a40-3b5c-4e7d-8a9b-0c1d2e3f4a53
actor=6f1d2a40-3b5c-4e7d-8a9b-0c1d2e3f4a5f

# Books a company as the app role: $1 its id, $2 its name, $3 its organisation number.
write_company() {
  sql nortfox_app << SQL
BEGIN;
SET LOCAL nortfox.company_id = '$1';
SET LOCAL nortfox.actor_id = '$actor';
SET LOCAL nortfox.actor_kind = 'system';
INSERT INTO ledger.companies (company_id, name, organization_number) VALUES ('$1', '$2', '$3');
COMMIT;
SQL
}

# How many rows of ledger.companies the app role sees with the company $1 set.
seen() {
  sql nortfox_app << SQL
BEGIN;
SET LOCAL nortfox.company_id = '$1';
SELECT count(*) FROM ledger.companies;
COMMIT;
SQL
}

# Closes the current WAL segment and waits until PostgreSQL has archived it,
# which means pgBackRest has it in both repositories.
archive_now() {
  local segment
  segment=$(sql postgres <<< 'SELECT pg_catalog.pg_walfile_name(pg_catalog.pg_switch_wal())')
  for _ in $(seq 120); do
    if [[ "$(sql postgres <<< "SELECT coalesce(last_archived_wal >= '$segment' COLLATE \"C\", false) FROM pg_catalog.pg_stat_archiver")" == t ]]; then
      step "the WAL segment $segment is archived."
      return 0
    fi
    sleep 1
  done
  fail "the WAL segment $segment was not archived within two minutes."
}

# Waits until PostgreSQL has replayed the WAL and takes writes again. A
# replay that cannot reach T stops PostgreSQL, and the container restarts.
wait_until_promoted() {
  local container restarts
  container=$(compose ps --all --quiet postgres)
  restarts=$(docker inspect --format '{{.RestartCount}}' "$container")
  for _ in $(seq 300); do
    if [[ "$(sql postgres <<< 'SELECT pg_catalog.pg_is_in_recovery()' 2> /dev/null || true)" == f ]]; then
      return 0
    fi
    if [[ "$(docker inspect --format '{{.RestartCount}}' "$container")" != "$restarts" ]]; then
      fail "PostgreSQL stopped during the restore."
    fi
    sleep 1
  done
  fail "PostgreSQL did not finish the restore within five minutes."
}

step "write 1, the time T, write 2."
write_company "$company_1" "Testbolaget Alfa AB" 556000-0167
target=$(sql postgres <<< 'SELECT pg_catalog.clock_timestamp()')
step "T is $target."
sleep 2
write_company "$company_2" "Testbolaget Beta AB" 599999-0129
archive_now
expect "write 1 before a restore" "$(seen "$company_1")" 1
expect "write 2 before a restore" "$(seen "$company_2")" 1

# Restores repository $1's full backup and replays its WAL up to T, on the
# backup's own timeline, then promotes.
restore_to_target() {
  local repo=$1
  step "restoring from repo$repo to T."
  compose stop postgres
  compose run --rm --no-deps --user postgres --entrypoint pgbackrest postgres \
    --stanza=nortfox "--repo=$repo" --delta --type=time "--target=$target" --target-action=promote \
    --target-timeline=current "--recovery-option=restore_command=pgbackrest --stanza=nortfox --repo=$repo archive-get %f \"%p\"" \
    restore
  compose start postgres
  wait_until_promoted
  expect "write 1 after the restore from repo$repo" "$(seen "$company_1")" 1
  expect "write 2 after the restore from repo$repo" "$(seen "$company_2")" 0
}

restore_to_target 1

# A write after the first restore, so that the second restore has something
# to take back.
write_company "$company_3" "Testbolaget Gamma AB" 556000-0167
archive_now
expect "write 3, after the first restore" "$(seen "$company_3")" 1

restore_to_target 2
expect "write 3 after the restore from repo2" "$(seen "$company_3")" 0

step "passed: a restore to T from either repository gives the state at T."
