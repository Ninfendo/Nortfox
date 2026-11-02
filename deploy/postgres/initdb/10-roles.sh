#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# The first start of an install only: the image's entrypoint runs this once,
# on an empty data folder, against its own setup server, which listens on its
# socket only. It makes the cluster roles from db/roles.sql. It closes the
# cluster's other databases, postgres and template1: it runs db/database.sql
# and db/other-databases.sql in each, so no role of ours connects to them, and
# a database made from template1 later starts with the functions that keep
# bytes outside the ledger closed. It sets the owner's and the app's passwords
# from the compose secrets, makes the database nortfox, owned by
# nortfox_owner, and runs db/database.sql in it. The migrate step makes
# everything else in it.
#
# A password is read as the migrate step reads it (apps/server/src/db/connect.ts):
# the whole file, without one line break at its end. It reaches psql through
# its environment, never through its command line.
set -euo pipefail

# Sets the variable named $2 to the password in the secret $1.
read_secret() {
  local file="/run/secrets/$1" text
  if [[ ! -s "$file" ]]; then
    echo "10-roles: the secret $1 is missing or empty. deploy/README.md says how to make it." >&2
    exit 1
  fi
  text=$(cat -- "$file" && printf x)
  text=${text%x}
  if [[ "$text" == *$'\n' ]]; then
    text=${text%$'\n'}
    text=${text%$'\r'}
  fi
  if [[ -z "$text" ]]; then
    echo "10-roles: the secret $1 holds no password." >&2
    exit 1
  fi
  printf -v "$2" '%s' "$text"
}

owner_password=
app_password=
read_secret owner-password owner_password
read_secret app-password app_password

psql=(psql --no-psqlrc --set ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}")

"${psql[@]}" --dbname postgres --file /usr/local/share/nortfox/roles.sql

for database in template1 postgres; do
  "${psql[@]}" --dbname "$database" --file /usr/local/share/nortfox/database.sql
  "${psql[@]}" --dbname "$database" --file /usr/local/share/nortfox/other-databases.sql
done

NORTFOX_OWNER_PASSWORD=$owner_password NORTFOX_APP_PASSWORD=$app_password "${psql[@]}" --dbname postgres <<'SQL'
\getenv owner_password NORTFOX_OWNER_PASSWORD
\getenv app_password NORTFOX_APP_PASSWORD
ALTER ROLE nortfox_owner PASSWORD :'owner_password';
ALTER ROLE nortfox_app PASSWORD :'app_password';
CREATE DATABASE nortfox OWNER nortfox_owner;
SQL

"${psql[@]}" --dbname nortfox --file /usr/local/share/nortfox/database.sql

echo "10-roles: made the roles and the database nortfox, owned by nortfox_owner. No role of ours connects to postgres or template1, and none can make a large object or write a WAL message."
