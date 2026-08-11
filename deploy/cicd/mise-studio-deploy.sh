#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

readonly DEPLOY_ROOT="/opt/miseStudio"
readonly UPLOAD_ROOT="/home/deploy/uploads"
readonly ENV_FILE="${DEPLOY_ROOT}/shared/.env"
readonly RELEASE_ENV="${DEPLOY_ROOT}/.release.env"
readonly COMPOSE_FILE="${DEPLOY_ROOT}/docker-compose.yml"
readonly COMPOSE_PROJECT="mise-studio"
readonly APP_CONTAINER="mise-studio-api-1"
readonly WEB_CONTAINER="mise-studio-web-1"
readonly BILLING_CONTAINER="mise-studio-billing-worker-1"
readonly CLEANUP_CONTAINER="mise-studio-media-cleanup-1"
readonly POSTGRES_CONTAINER="mise-studio-postgres-1"
readonly PUBLIC_HEALTH_URL="https://video.0000238.xyz/"
readonly LOCK_FILE="/var/lock/mise-studio-deploy.lock"

usage() {
  echo "Usage: mise-studio-deploy <image-archive> <app-image> <web-image> <git-revision>" >&2
  exit 2
}

[[ $# -eq 4 ]] || usage

archive_input=$1
app_image=$2
web_image=$3
git_revision=$4

[[ $app_image =~ ^mise-studio-app:git-[0-9a-f]{40}$ ]] || {
  echo "Invalid application image: ${app_image}" >&2
  exit 2
}

[[ $web_image =~ ^mise-studio-web:git-[0-9a-f]{40}$ ]] || {
  echo "Invalid web image: ${web_image}" >&2
  exit 2
}

[[ $git_revision =~ ^[0-9a-f]{40}$ ]] || {
  echo "Invalid Git revision: ${git_revision}" >&2
  exit 2
}

archive_path=$(readlink -f -- "$archive_input")
case "$archive_path" in
  "${UPLOAD_ROOT}"/mise-studio-*.tar.gz) ;;
  *)
    echo "Archive must be inside ${UPLOAD_ROOT}" >&2
    exit 2
    ;;
esac

[[ -f $archive_path && ! -L $archive_path ]] || {
  echo "Image archive does not exist: ${archive_path}" >&2
  exit 2
}

[[ -f $ENV_FILE && -f $COMPOSE_FILE && -f $RELEASE_ENV ]] || {
  echo "miseStudio production configuration is incomplete" >&2
  exit 2
}

exec 9>"$LOCK_FILE"
flock -n 9 || {
  echo "Another miseStudio deployment is already running" >&2
  exit 1
}

compose() {
  docker compose \
    --env-file "$ENV_FILE" \
    --env-file "$RELEASE_ENV" \
    --project-name "$COMPOSE_PROJECT" \
    --file "$COMPOSE_FILE" \
    "$@"
}

write_release_images() {
  local target_app_image=$1
  local target_web_image=$2
  local temporary_file
  temporary_file=$(mktemp "${DEPLOY_ROOT}/.release.env.XXXXXX")
  printf 'MISE_STUDIO_APP_IMAGE=%s\nMISE_STUDIO_WEB_IMAGE=%s\n' \
    "$target_app_image" \
    "$target_web_image" \
    > "$temporary_file"
  chmod 600 "$temporary_file"
  mv -f "$temporary_file" "$RELEASE_ENV"
}

container_status() {
  docker inspect --format '{{.State.Status}}' "$1" 2>/dev/null || true
}

wait_for_application() {
  local attempt
  local api_health
  local web_health

  for attempt in $(seq 1 60); do
    api_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$APP_CONTAINER" 2>/dev/null || true)
    web_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$WEB_CONTAINER" 2>/dev/null || true)
    if [[ $api_health == "healthy" && $web_health == "healthy" ]] && \
       [[ $(container_status "$BILLING_CONTAINER") == "running" ]] && \
       [[ $(container_status "$CLEANUP_CONTAINER") == "running" ]] && \
       docker exec "$APP_CONTAINER" python -c \
         "import json, urllib.request; data=json.load(urllib.request.urlopen('http://new-api:3000/api/status', timeout=10)); assert data.get('success') is True" && \
       docker exec "$WEB_CONTAINER" wget -q -O /dev/null http://127.0.0.1:8080/; then
      return 0
    fi
    sleep 5
  done

  compose ps >&2 || true
  compose logs --tail=200 api web billing-worker media-cleanup >&2 || true
  return 1
}

activate_images() {
  compose up -d --no-deps --no-build --force-recreate \
    api billing-worker media-cleanup web
}

rollback_to_previous_images() {
  local reason=$1
  echo "${reason}; rolling back application images" >&2
  write_release_images "$previous_app_image" "$previous_web_image"
  activate_images || true
  wait_for_application || {
    echo "Rollback containers also failed their health checks" >&2
    exit 1
  }
  exit 1
}

cd "$DEPLOY_ROOT"

previous_app_image=$(docker inspect --format '{{.Config.Image}}' "$APP_CONTAINER")
previous_web_image=$(docker inspect --format '{{.Config.Image}}' "$WEB_CONTAINER")
timestamp=$(date -u +'%Y%m%dT%H%M%SZ')
backup_directory="${DEPLOY_ROOT}/backups/deploy/${timestamp}-${git_revision:0:12}"
mkdir -p "$backup_directory"

echo "Creating pre-deployment PostgreSQL backup"
docker exec "$POSTGRES_CONTAINER" sh -c \
  'exec pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  > "${backup_directory}/mise-studio.pg_dump"

echo "Loading ${app_image} and ${web_image}"
gzip -t "$archive_path"
docker load --input "$archive_path" > /dev/null
docker image inspect "$app_image" "$web_image" > /dev/null

write_release_images "$app_image" "$web_image"

echo "Applying database migrations"
if ! compose --profile ops run --rm --no-deps migrate; then
  write_release_images "$previous_app_image" "$previous_web_image"
  echo "Database migration failed; application containers were not replaced" >&2
  exit 1
fi

echo "Activating ${app_image} and ${web_image}"
if ! activate_images; then
  rollback_to_previous_images "New containers could not be started"
fi

if ! wait_for_application; then
  rollback_to_previous_images "New containers failed their health checks"
fi

if command -v curl > /dev/null 2>&1; then
  if ! curl --fail --silent --show-error --max-time 20 "$PUBLIC_HEALTH_URL" > /dev/null; then
    rollback_to_previous_images "Public endpoint verification failed"
  fi
fi

rm -f -- "$archive_path"
printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
  "$git_revision" \
  "$app_image" \
  "$web_image" \
  "$previous_app_image" \
  "$previous_web_image" \
  >> "${DEPLOY_ROOT}/deploy-history.tsv"

echo "Deployment completed: ${git_revision}"
