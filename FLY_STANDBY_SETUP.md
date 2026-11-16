# Fly.io standby deployment preparation

This repository includes a **configuration template only**. No Fly.io app, database,
billing agreement, secret, or production deployment has been created.

## Why this exists

The current Render PostgreSQL Free database is temporary. This template gives an
authorised adult operator a reviewed starting point for a second hosting environment
before the Render database expires.

## Current limits

- The app listens on `PORT` (defaults to 3000) and binds to `0.0.0.0`.
- The Fly app name in `fly.toml` is deliberately a placeholder.
- No database is provisioned or attached.
- No credentials or API keys belong in this repository.
- This is a **manual standby**, not automatic failover.
- Do not direct real hotel traffic to it until the restore, security, privacy,
  integration, and operational checks are complete.

## Adult operator checklist

1. Create or select the Fly.io organisation and billing account.
2. Review current Fly.io Managed Postgres pricing and regions. Managed Postgres
   pricing currently starts at USD $38/month plus USD $0.28 per provisioned GB/month;
   application compute, network transfer, and any other services are additional.
3. Choose a unique app name and replace the placeholder in `fly.toml`.
4. Provision the Managed Postgres cluster in the same region as the app, if approved.
5. Restore a verified backup into the new database. Do not point the app at an empty
   database and assume existing customer records have migrated.
6. Configure required environment variables using the provider's secret manager,
   including `DATABASE_URL` and the approved production settings. Never commit secrets.
7. Deploy this app and verify `/api/health`, `/api/readiness`, tenant isolation,
   guest-answer grounding, staff handoff, and database persistence.
8. Run a controlled rehearsal with fictional data before any DNS or customer traffic
   changes.
9. Keep Render available until the new app and restored database have passed the
   rehearsal. Plan a controlled cutover and rollback window.

## Important database cutover rule

Do not let Render and Fly.io independently accept writes against separate databases
during a cutover. That would split customer data. Freeze writes or use a properly
designed migration/cutover process, verify the final export/import, then switch traffic.

## Official references

- Fly.io pricing: https://fly.io/pricing/
- Fly.io Managed Postgres: https://docs.fly.io/postgres/
- Fly.io app configuration: https://fly.io/docs/reference/configuration/
