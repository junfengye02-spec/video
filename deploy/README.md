# miseStudio production deployment

The production installation lives under `/opt/miseStudio` and uses the stable
Docker Compose project name `mise-studio`. PostgreSQL, Redis, and project media
use dedicated named volumes and do not share New API state.

Runtime services:

- `web`: built Vite application and same-origin `/api` proxy.
- `api`: FastAPI application.
- `billing-worker`: single New API billing reconciliation worker.
- `media-cleanup`: deletes project video files after 24 hours, every hour.
- `postgres` and `redis`: miseStudio-only persistence.

The API joins `new-api-prod_new-api-prod-network` and reaches the existing New
API service at `http://new-api:3000`. Caddy reaches the web service through the
stable `mise-studio-web` network alias.

Server layout:

```text
/opt/miseStudio/
  current -> releases/<release-id>
  releases/<release-id>/
  shared/.env
  shared/backups/
  shared/bootstrap/openmontage.dump
  shared/bootstrap/projects.tar.gz
  incoming/
```

On the first deployment only, `deploy.sh` restores the optional custom-format
PostgreSQL dump and project archive from `shared/bootstrap/`, then writes the
`shared/bootstrap-complete` marker. Redis is intentionally not migrated so all
browser sessions are revoked during the server move.

Each deployment builds both images, starts isolated infrastructure, writes a
compressed PostgreSQL backup, applies Alembic migrations, replaces the app
services, verifies FastAPI, the web frontend, and the internal New API route,
then updates the `current` symlink.

GitHub Actions repository secrets required by `.github/workflows/deploy.yml`:

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`
- `DEPLOY_KNOWN_HOSTS`

The public route is `video.0000238.xyz`; merge
`deploy/Caddyfile.miseStudio` into `/opt/new-api/Caddyfile` and reload the
existing Caddy container after the DNS record points at the server.
