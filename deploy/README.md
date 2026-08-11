# miseStudio production deployment

The production installation lives under `/opt/miseStudio` and follows the same
image-based CI/CD pattern as New API. GitHub Actions builds Linux AMD64 images,
uploads one archive through the shared `deploy` account, and invokes the
root-owned `/usr/local/sbin/mise-studio-deploy` program. PostgreSQL, Redis, and
project media use dedicated named volumes and do not share New API state.

Runtime services:

- `web`: built Vite application and same-origin `/api` proxy.
- `api`: FastAPI application.
- `billing-worker`: single New API billing reconciliation worker.
- `media-cleanup`: deletes project video files after 24 hours, every hour.
- `postgres` and `redis`: miseStudio-only persistence.

The API joins `new-api-prod_new-api-prod-network` and reaches the existing New
API service at `http://new-api:3000`. Caddy reaches the web service through the
stable `mise-studio-web` network alias.

Stable server layout:

```text
/opt/miseStudio/
  docker-compose.yml
  .release.env
  shared/.env
  backups/deploy/
  deploy-history.tsv
/home/deploy/uploads/
/usr/local/sbin/mise-studio-deploy
```

The first migration was bootstrapped with `deploy.sh`. Normal releases now use
`deploy/cicd/mise-studio-deploy.sh`: it locks deployment, backs up PostgreSQL,
loads the two prebuilt images, applies Alembic migrations, replaces only the
four application services, verifies FastAPI/Web/New API connectivity, and
rolls back both images when activation or health checks fail.

GitHub Actions repository secrets required by
`.github/workflows/deploy-production.yml`:

- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_SSH_KEY`
- `DEPLOY_KNOWN_HOSTS`

The public route is `video.0000238.xyz`. Caddy routing is a one-time server
configuration and is not replaced during application deployments. See
`deploy/cicd/README.zh_CN.md` for the operational handoff.
