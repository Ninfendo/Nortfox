# SPDX-License-Identifier: AGPL-3.0-only
#
# PostgreSQL with pgBackRest, for a NortFox install
# (docs/decisions/0007-self-hosting-and-backups.md). Build it from the
# repository root, as deploy/compose.yaml does:
#
#   docker build --file deploy/postgres/Dockerfile .
#
# The base image is the same PostgreSQL, by the same digest, as CI and the
# test database (scripts/guards/images.ts). pgBackRest comes from the image's
# own PostgreSQL apt source, at a pinned version (scripts/guards/deploy.ts);
# deploy/README.md says how to move the pin.
#
# The image adds:
# - pgBackRest and its config, /etc/pgbackrest/pgbackrest.conf;
# - /var/lib/pgbackrest, the local repository (repo1), for the backups volume;
# - /var/lib/pgbackrest-offsite, where an off-site repository that is a mounted
#   folder (repo2 of type posix) goes;
# - /etc/pgbackrest/conf.d, where the compose file mounts the off-site
#   repository's other options;
# - db/roles.sql, db/database.sql and db/other-databases.sql, and the
#   first-start scripts in /docker-entrypoint-initdb.d.

FROM postgres:18-bookworm@sha256:5c4783a8cc3f0074912164f94dfa1be4e043438f0f707cf968d7af9a0d31a2c8

RUN apt-get update \
  && apt-get install --yes --no-install-recommends pgbackrest=2.60.0-1.pgdg12+1 \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /etc/pgbackrest.conf \
  && install --directory --owner=postgres --group=postgres --mode=0750 \
    /var/lib/pgbackrest /var/lib/pgbackrest-offsite /var/log/pgbackrest \
  && install --directory --mode=0755 /etc/pgbackrest /etc/pgbackrest/conf.d /usr/local/share/nortfox

COPY --chmod=0644 deploy/postgres/pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
COPY --chmod=0644 db/roles.sql /usr/local/share/nortfox/roles.sql
COPY --chmod=0644 db/database.sql /usr/local/share/nortfox/database.sql
COPY --chmod=0644 db/other-databases.sql /usr/local/share/nortfox/other-databases.sql
COPY --chmod=0755 deploy/postgres/initdb/ /docker-entrypoint-initdb.d/
