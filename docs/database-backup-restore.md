# Veyra PostgreSQL backup and restore runbook

**Status: procedure documented; no backup or restore has yet been performed.**

## Current database facts

- Render database: `veyra-core-db`
- PostgreSQL: 18
- Region: Singapore
- Current plan: Free
- Scheduled expiry: 11 December 2026
- The current Free database has no Render-managed backups, exports, or point-in-time recovery.
- External connections are currently blocked because the database IP allowlist is empty.

Do not store real hotel or guest data in this prototype database.

## Who should perform this

A parent/guardian or another authorized adult must manage the Render account, database credentials, network allowlist, and any paid plan decision. Never send a database URL, password, backup key, or dump file through ChatGPT, email, public chat, or a GitHub commit.

## A. Create a manual backup before 11 December 2026

1. On a trusted computer, install PostgreSQL 18 client tools so `pg_dump`, `pg_restore`, and `psql` are available.
2. Open the database in the Render Dashboard and obtain its **external** database URL. Do not use the internal URL from a computer outside Render.
3. In the database's Networking settings, temporarily allowlist only the trusted computer's current public IP as a single-address rule (`/32` for IPv4). Never open access to all addresses (`0.0.0.0/0`).
4. In a terminal on that computer, set `DATABASE_URL` as a temporary environment variable using the external URL. Do not put the URL in a script, shell history, screenshot, or repository.
5. Create a compressed custom-format dump:

   PowerShell:
   ```powershell
   $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
   $backup = "veyra-$stamp.dump"
   pg_dump --format=custom --no-owner --no-acl --file="$backup" "$env:DATABASE_URL"
   if ($LASTEXITCODE -ne 0) { throw "pg_dump failed" }
   ```

   macOS/Linux shell:
   ```bash
   stamp=$(date -u +%Y%m%d-%H%M%S)
   backup="veyra-$stamp.dump"
   pg_dump --format=custom --no-owner --no-acl --file="$backup" "$DATABASE_URL"
   ```

6. Verify that PostgreSQL can read the archive's table of contents:

   ```bash
   pg_restore --list veyra-YYYYMMDD-HHMMSS.dump
   ```

   Also record a SHA-256 checksum. On PowerShell use `Get-FileHash .\\veyra-YYYYMMDD-HHMMSS.dump -Algorithm SHA256`; on macOS use `shasum -a 256`; on Linux use `sha256sum`.
7. Move the dump to an encrypted, access-controlled backup location outside the Git repository. Keep a second protected copy in a separate location. Do not upload database dumps to GitHub.
8. Remove the temporary IP allowlist entry in Render and clear the temporary `DATABASE_URL` environment variable from the terminal session.

A successful `pg_dump` and `pg_restore --list` proves that an archive was created and is readable; it does **not** prove that a restore works.

## B. Test the restore safely

Perform this on a separate, empty local PostgreSQL 18 database or a separate disposable test database. Never restore over the live Veyra database.

1. Create a new empty database named `veyra_restore_test` on the test PostgreSQL server.
2. Set `RESTORE_TEST_DATABASE_URL` to that test database's connection URL.
3. Restore the archive:

   ```bash
   pg_restore --exit-on-error --no-owner --no-acl --dbname="$RESTORE_TEST_DATABASE_URL" veyra-YYYYMMDD-HHMMSS.dump
   ```

4. Confirm the expected Veyra tables exist and inspect basic row counts using `psql`. Do not publish row contents or credentials.
5. Run the application's test suite against the restored copy only, if the test setup is compatible with the restored schema.
6. Record the restore date, PostgreSQL version, archive filename, checksum, and whether table checks and application tests passed.
7. Keep the original archive unchanged. Delete the disposable test database only after the restore test has been documented.

## C. Ongoing backup policy

- Until the database is migrated, make and verify a manual dump at least weekly and before schema-changing deployments.
- Keep at least two protected copies in separate locations, with encryption at rest and access limited to the authorized adult/operator.
- Once the project is approved for a paid database, confirm the exact Render plan's recovery window and logical-export options. Render documents 3 days of PITR for Hobby workspaces and 7 days for Pro-or-higher workspaces on paid Postgres. Logical exports are retained by Render for 7 days after creation. These are not a substitute for an independently retained archive.
- A Free Render Postgres database has no managed backups and expires after 30 days. After expiry there is a 14-day upgrade grace period before deletion. Do not rely on that grace period as a backup strategy.

## Release gate

Do not mark `durableBackupsVerified` or `DURABLE_BACKUPS_VERIFIED=true` until all of the following evidence exists:

- A manual archive was created successfully.
- Its SHA-256 checksum was recorded.
- The archive was stored outside GitHub in protected storage.
- A restore into a separate empty database completed successfully.
- Expected tables and application checks were verified.
- An authorized adult/operator reviewed and recorded the evidence.

**Current result: NOT VERIFIED.** This runbook documents the process only. No database backup, restore, network allowlist change, plan upgrade, or credential change has been performed by this commit.
