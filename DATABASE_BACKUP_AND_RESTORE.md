# Veyra AI — database backup and restore runbook

**Status: NOT YET EXECUTED OR VERIFIED.** This document is a procedure, not evidence that a backup exists. The current prototype database is Render Free Postgres and has no built-in backups, snapshots or point-in-time recovery.

## Current prototype database

- Render resource: `veyra-core-db`
- Region: Singapore
- PostgreSQL: 18
- Compute plan: Free
- Current observed status: available
- Scheduled expiry: 11 December 2026
- Built-in backup / PITR support: none on Free

Do not store real hotel or guest data in this prototype database. The prototype contains synthetic/demo data only. Do not delete it or assume it can be recovered after expiry.

## Who may perform this procedure

A parent/guardian or other authorised adult account owner must perform all hosting-account, database, credential, billing and storage operations. The young founder must not receive, paste into chat, commit, screenshot or otherwise handle database URLs, passwords, API keys or backup-storage credentials.

The Render MCP read-only database query was unable to connect because the database IP allowlist is empty. Do not weaken or broaden the allowlist to work around this. The adult account owner should use their own trusted workstation and follow the provider's current access controls.

## Backup procedure

1. The adult operator opens the database in Render and obtains its external connection URL privately. Never place the URL in Git, issue comments, screenshots, chat, logs or a command literal.
2. On a trusted workstation with PostgreSQL 18 client tools installed, the adult operator supplies the connection URL to the process environment as `DATABASE_URL` using their approved secret-handling method.
3. Create a private backup directory and a timestamped output filename. Ensure the destination is encrypted at rest and accessible only to authorised adults.
4. Create a PostgreSQL custom-format archive:

   ```sh
   umask 077
   BACKUP_FILE="veyra-core-$(date -u +%Y%m%dT%H%M%SZ).dump"
   pg_dump --format=custom --no-owner --no-acl --file="$BACKUP_FILE" "$DATABASE_URL"
   ```

5. Check that the archive exists and is non-empty. Inspect its table-of-contents without printing any connection details:

   ```sh
   test -s "$BACKUP_FILE"
   pg_restore --list "$BACKUP_FILE" > "$BACKUP_FILE.contents.txt"
   test -s "$BACKUP_FILE.contents.txt"
   ```

6. Copy the archive to encrypted durable storage outside the Render database and outside the application's ephemeral filesystem. Keep a second protected copy in a separate storage location. Do not commit backups to this repository or upload them as public build artifacts.
7. Record only non-secret evidence: UTC backup time, archive filename, byte size, SHA-256 checksum, PostgreSQL client version, source database identifier, and the adult operator who verified the copy. Never record the connection URL or password.

## Restore drill — required before claiming backups are verified

A valid archive is not enough. The adult operator must provision an isolated, temporary PostgreSQL 18 restore target with no important data in it. Do not restore over the live database.

1. Supply the restore target connection URL privately as `RESTORE_DATABASE_URL`.
2. Restore into the empty isolated target:

   ```sh
   pg_restore --exit-on-error --single-transaction --no-owner --no-acl \
     --dbname="$RESTORE_DATABASE_URL" "$BACKUP_FILE"
   ```

3. Confirm the restore completed without errors. Compare expected schema/table presence and non-sensitive row counts with the source backup metadata. Run application migration/status checks against the isolated target.
4. Run the relevant application integration tests against the restored database, or document any reason they cannot safely run against that copy.
5. Record the restore start/end time, result, test evidence, and any errors. Keep the restore target isolated; delete it only after the adult operator has confirmed the evidence and no longer needs it.

## Definition of done

Do not set `DURABLE_BACKUPS_VERIFIED=true` until all of the following have evidence:

- A complete backup archive was created successfully.
- The archive was copied to encrypted durable storage outside Render.
- A second protected copy exists in a separate storage location.
- The archive checksum and metadata were recorded.
- A restore into a separate empty database completed successfully.
- Schema and application-level checks passed against the restored copy.
- An authorised adult operator approved the recovery evidence and retention schedule.

## Ongoing policy

- Repeat backups on a schedule appropriate to the data's importance and before risky schema or data migrations.
- Retain multiple generations according to an adult-approved retention policy.
- Periodically test restores, not just archive creation.
- Never use a backup from the synthetic prototype as a production hotel's database.
- Before any future hotel pilot, use a separate production-grade database with provider-supported recovery and a tested off-platform export process.
- Never delete or allow the current database to expire before the adult operator has confirmed that any required synthetic demo data is safely exported or intentionally disposable.

## Provider documentation

- Render Postgres recovery and backups: https://render.com/docs/postgresql-backups
- Render Free Postgres limitations: https://render.com/docs/free
