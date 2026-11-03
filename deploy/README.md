# Running NortFox yourself

One Docker Compose file runs an install ([decision 7](../docs/decisions/0007-self-hosting-and-backups.md)). Today it runs PostgreSQL with pgBackRest and the one-shot migrate step. The server image holds the server too, but this file starts it only from slice 2c on, with Caddy in front of it: until 2c brings login, the server knows no actor, so it would answer 401 to every request for data.

| Service | What it does |
| --- | --- |
| `postgres` | PostgreSQL 18 with pgBackRest, built from `postgres/Dockerfile`. It archives every WAL segment to two backup repositories: a local one and an off-site one. |
| `migrate` | Built from `server/Dockerfile`. It applies `db/migrations` as the owner role, `nortfox_owner`, once PostgreSQL is healthy, and then stops. It never restarts. |

You need Docker with Compose v2, and this repository. Run every command below from the `deploy` folder. Compose then reads `compose.yaml`, your `.env` and, if you add one, your `compose.override.yaml`.

## Before the first start

### The secrets

Make the folder `deploy/secrets` with four files. Git ignores the folder.

| File | What it holds |
| --- | --- |
| `postgres-password` | The password of the superuser `postgres`. Only the first start and the operator use it. |
| `owner-password` | The password of `nortfox_owner`: the migrations, and later the restore tool. |
| `app-password` | The password of `nortfox_app`: the server, which this file runs from slice 2c on. |
| `repo2.conf` | The off-site repository's options, in pgBackRest's own form (below). |

For example:

```sh
mkdir -m 0700 secrets
for name in postgres-password owner-password app-password; do
  openssl rand -hex 32 > "secrets/$name"
done
chmod 0644 secrets/*
```

Each password is the whole file, without one line break at its end. The files must be readable inside the containers, which run as other users than you, so give them mode 0644. The folder's mode 0700 keeps the other users of the host out.

The first start sets the passwords. Changing a file later changes no password.

### The off-site repository

pgBackRest writes every backup and every WAL segment to two repositories. `repo1` is the local one, on the volume `backups`. `repo2` is the off-site one, and you choose where it is. The stack does not start until you set it.

Set its type and its path in `deploy/.env`:

```sh
NORTFOX_REPO2_TYPE=s3
NORTFOX_REPO2_PATH=/nortfox
```

The type is one of pgBackRest's repository types: `s3`, `gcs`, `azure`, `sftp`, `cifs` or `posix`. Put the type's other options in `secrets/repo2.conf`, with their `repo2-` names. For storage that speaks S3:

```ini
[global]
repo2-s3-bucket=example-bucket
repo2-s3-endpoint=s3.example.com
repo2-s3-region=eu-north-1
repo2-s3-key=<access key id>
repo2-s3-key-secret=<secret access key>
```

[pgBackRest's configuration reference](https://pgbackrest.org/configuration.html) lists the options of each type. It can also encrypt a repository (`repo2-cipher-type` and `repo2-cipher-pass`). NortFox sets no encryption by default. An option like that goes in before the first start, because the first start makes the stanza in both repositories.

An off-site repository that is a mounted folder has the type `posix` and the path `/var/lib/pgbackrest-offsite`. Mount the folder there in `deploy/compose.override.yaml`, and make it writable for the user `postgres` in the container (uid 999). The first start refuses an off-site repository of type `posix` or `cifs` whose path is no mount of its own: the folder in the image is only the place to mount it, and without a mount its backups would stay in the container, on the same disk as the data, and go when the container is made again.

```yaml
services:
  postgres:
    volumes:
      - /mnt/offsite/nortfox:/var/lib/pgbackrest-offsite
```

`secrets/repo2.conf` must be there even when the type needs no other option. It may then hold only the line `[global]`.

## Start

```sh
docker compose up --detach
docker compose ps --all
```

On the first start, PostgreSQL makes the roles from `db/roles.sql`. It closes the cluster's other databases, `postgres` and `template1`, with `db/database.sql` and `db/other-databases.sql`, so that no role of ours connects to them. It sets the passwords, makes the database `nortfox`, owned by `nortfox_owner`, and runs `db/database.sql` in it, so that no role of ours can make a large object, write a message in the WAL or read the locks that other backends hold (`pg_locks`) there. Then it checks its archive settings, checks that an off-site folder is a mount, makes the pgBackRest stanza `nortfox` in both repositories, and has pgBackRest prove that a WAL segment reaches both. It writes the file `nortfox-first-backups-pending` on the volume `data`, outside the data folder, and the file `nortfox-first-start-done` in the data folder. Then it takes the first full backup to each repository, while the database is still empty, so the WAL archive has a backup to replay onto from the first start on. If a backup fails, it removes `nortfox-first-start-done` again. Once both backups are taken, it removes `nortfox-first-backups-pending`. The service is healthy only when `nortfox-first-start-done` is there, `nortfox-first-backups-pending` is not, and PostgreSQL answers over TCP. Only then does the migrate step run. `docker compose ps --all` shows the migrate step as exited with code 0. `nortfox-first-start-done` is part of the data, so a full backup holds it and a restore brings it back. No backup holds `nortfox-first-backups-pending`.

If the first start fails, `docker compose logs postgres` says why. A wrong off-site repository is the most likely cause. Docker then starts PostgreSQL again, and the image skips its setup, because the data folder is no longer empty. But `nortfox-first-start-done` is missing, so the service never becomes healthy, the migrate step never runs, and `docker compose up` waits and then stops with an error. A first start that stops during its first full backups, for example when the host loses power or Docker kills the container, does not finish either: `nortfox-first-backups-pending` is still there, and the service never becomes healthy. Fix the cause, then remove the half-made data and start again:

```sh
docker compose down --volumes
docker compose up --detach
```

Do this only after a failed first start. `--volumes` removes the data and the local repository. It does not touch the off-site repository. So look in the log for the line `20-stanza: made the stanza nortfox in both repositories.`:

- If the log holds it, the failed start left its stanza in the off-site repository too, and the next first start would stop with pgBackRest's error `[028]`, because its new cluster does not match that stanza. Then, after `down --volumes` and before `up --detach`, empty the off-site repository's path, `NORTFOX_REPO2_PATH`: the folder, or that prefix in the bucket. It holds only the archive of the half-made cluster.
- If the log does not hold it, the failed start made no stanza there. Leave the off-site repository as it is.

Never empty a path that holds another install's backups.

## The backup settings

| Setting | Value | Where | What it does |
| --- | --- | --- | --- |
| `wal_level` | `replica` | `compose.yaml` | The WAL holds what a restore needs. |
| `archive_mode` | `on` | `compose.yaml` | PostgreSQL archives every finished WAL segment. |
| `archive_command` | `pgbackrest --stanza=nortfox archive-push %p` | `compose.yaml` | pgBackRest pushes each segment to both repositories. A segment counts as archived only when both have it. |
| `archive_timeout` | `60` (seconds) | `compose.yaml` | PostgreSQL archives the WAL in whole segments. So it closes the current segment after at most 60 seconds of writes, and the archive stays about a minute behind the last commit. |
| `repo1-path` | `/var/lib/pgbackrest` | `postgres/pgbackrest.conf` | The local repository, on the volume `backups`, on the same host as the data. |
| `repo2-type`, `repo2-path` | `NORTFOX_REPO2_TYPE`, `NORTFOX_REPO2_PATH` | `.env` | The off-site repository. The compose file requires both. |
| the other `repo2-` options | yours | `secrets/repo2.conf` | How pgBackRest reaches the off-site repository. |
| `repo1-retention-full`, `repo2-retention-full` | `9999999` | `postgres/pgbackrest.conf` | Each repository keeps every full backup, with the WAL it needs. Removing an old backup is your step, never pgBackRest's. |
| `pg1-path` | `/var/lib/postgresql/18/docker` | `postgres/pgbackrest.conf` | The data folder of the PostgreSQL 18 image, on the volume `data`. |

`scripts/guards/deploy.ts` pins these settings in the files, and `pnpm backup:test` checks them on a running stack.

### Where räkenskapsinformation may be kept

Bokföringslagen (1999:1078) 7 kap. 2 §, 3 a § and 4 § say where räkenskapsinformation may be kept:

- In Sweden.
- Electronic räkenskapsinformation also in another EU country, or in a country with equal rules on mutual assistance, when the company reports the place, and every change of it, to Skatteverket, or to Finansinspektionen if Finansinspektionen supervises the company; gives Skatteverket or Tullverket, when either asks, immediate electronic access to the information; and can print it in Sweden at once.
- Anywhere else, only with Skatteverket's permission, or Finansinspektionen's for a company that Finansinspektionen supervises.

This section states the law, and nothing more. It does not settle how the law applies to a backup copy, or where a company keeps its repositories.

## Take a backup

The WAL archive is of use only together with a full backup to replay it onto. The first start takes the first full backup to each repository (Start, above). Take later full backups on a schedule of your own, for example with cron on the host: a restore replays the WAL from the newest full backup before its target, so a newer backup makes a restore shorter. NortFox does not schedule backups yet.

```sh
docker compose exec --user postgres postgres pgbackrest --stanza=nortfox --repo=1 --type=full backup
docker compose exec --user postgres postgres pgbackrest --stanza=nortfox --repo=2 --type=full backup
docker compose exec --user postgres postgres pgbackrest --stanza=nortfox info
```

`info` shows `status: ok`, each backup with the repository that holds it, and the oldest and the newest archived WAL segment.

## Restore to a point in time

A restore to an earlier point is for disaster recovery only. A mistake is fixed in the books, as [decision 2](../docs/decisions/0002-ledger-law-in-postgresql.md) allows, never with a restore.

A restore by hand, as below, records no void range. So after it, a voucher series can give out a number again that it gave out after the restore point. The restore tool of plan step 4b finds the highest number given out and records the skipped numbers as a void range ([decision 7](../docs/decisions/0007-self-hosting-and-backups.md)).

Stop PostgreSQL, restore, and start it again. The time is the moment to restore to, with its time zone. `--repo=1` restores from the local repository, `--repo=2` from the off-site one.

```sh
docker compose stop postgres
docker compose run --rm --no-deps --user postgres --entrypoint pgbackrest postgres \
  --stanza=nortfox --repo=1 --delta --type=time "--target=2026-11-02 10:15:00+01" --target-action=promote restore
docker compose start postgres
```

PostgreSQL replays the archived WAL up to that moment, then opens the database for writes. `docker compose logs postgres` shows where the replay stopped.

## The restore test

```sh
pnpm backup:test
```

It runs `backup-test/pitr.sh`. The test builds and starts this compose file under a project of its own, `nortfox-backup-test`, with made-up secrets and a second local volume in place of the off-site repository. It first checks that a first start that does not finish never becomes healthy: one whose off-site repository cannot be written, one whose off-site folder is no mount, and one killed during its first full backups. Then it checks the archive settings, the migrate step, the owner of every table, that our roles, a reader among them, connect to the database `nortfox` only, that none of them can make a large object, write a message in the WAL or read `pg_locks` in any database, that the first start took a full backup to each repository, and both repositories on the running stack. Then it writes, notes the time, and writes again, and restores to that time from `repo1` and again from `repo2`, each from its own repository alone. Each restore must give the first write and not the second. The test removes its containers and volumes when it ends. It needs bash and Docker. CI runs it in the job `backup`.

## Moving a pin

**pgBackRest** comes from the PostgreSQL apt source at the version in `postgres/Dockerfile`. That source keeps a few versions, so an old pin can disappear from it, and the build then fails. To move the pin, list the versions:

```sh
docker run --rm postgres:18-bookworm@sha256:<the digest in postgres/Dockerfile> \
  bash -c 'apt-get update -qq && apt-cache madison pgbackrest'
```

Read the release notes of the new version, set it in `postgres/Dockerfile`, and run `pnpm backup:test`.

**PostgreSQL** is pinned by its digest in three places: `postgres/Dockerfile`, `test-database/compose.yaml` and the `build` job in `.github/workflows/ci.yml`. `scripts/guards/images.ts` fails when they differ. A new major version also changes `pg1-path` and the data folder.

**pnpm** in `server/Dockerfile` is the version that `package.json` names. `scripts/guards/deploy.ts` fails when they differ.
