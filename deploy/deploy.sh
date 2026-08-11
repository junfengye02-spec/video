#!/usr/bin/env bash
set -Eeuo pipefail

release_dir="${1:?release directory is required}"
base_dir="/opt/miseStudio"
shared_dir="$base_dir/shared"
env_file="$shared_dir/.env"
backup_dir="$shared_dir/backups"
bootstrap_dir="$shared_dir/bootstrap"
bootstrap_marker="$shared_dir/bootstrap-complete"

resolved_release="$(readlink -f "$release_dir")"
case "$resolved_release" in
  "$base_dir"/releases/*) ;;
  *)
    echo "release directory must be inside $base_dir/releases" >&2
    exit 2
    ;;
esac

export MISE_STUDIO_IMAGE_TAG="$(basename "$resolved_release")"
export MISE_STUDIO_ENV_FILE="$env_file"

if [[ ! -f "$env_file" ]]; then
  echo "missing deployment environment: $env_file" >&2
  exit 2
fi

compose=(
  docker compose
  --project-name mise-studio
  --env-file "$env_file"
  --file "$resolved_release/deploy/docker-compose.production.yml"
)

mkdir -p "$backup_dir"

"${compose[@]}" build --pull
"${compose[@]}" up -d postgres redis

wait_for_health() {
  local service="$1"
  local attempts="${2:-60}"
  local container status
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    container="$("${compose[@]}" ps -q "$service")"
    if [[ -n "$container" ]]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")"
      if [[ "$status" == "healthy" || "$status" == "running" ]]; then
        return 0
      fi
      if [[ "$status" == "unhealthy" || "$status" == "exited" || "$status" == "dead" ]]; then
        break
      fi
    fi
    sleep 2
  done
  "${compose[@]}" logs --tail=200 "$service" >&2 || true
  echo "$service did not become healthy" >&2
  return 1
}

wait_for_health postgres
wait_for_health redis

if [[ ! -f "$bootstrap_marker" ]]; then
  if [[ -f "$bootstrap_dir/openmontage.dump" ]]; then
    "${compose[@]}" exec -T postgres sh -c \
      'pg_restore --clean --if-exists --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
      < "$bootstrap_dir/openmontage.dump"
  fi
  if [[ -f "$bootstrap_dir/projects.tar.gz" ]]; then
    docker run --rm \
      --volume mise-studio-projects:/data \
      --volume "$bootstrap_dir:/bootstrap:ro" \
      postgres:16-alpine \
      tar -xzf /bootstrap/projects.tar.gz -C /data
  fi
  touch "$bootstrap_marker"
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
database_backup="$backup_dir/postgres-$timestamp.sql.gz"
"${compose[@]}" exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  | gzip -9 > "$database_backup.tmp"
mv "$database_backup.tmp" "$database_backup"

"${compose[@]}" --profile ops run --rm migrate
"${compose[@]}" up -d --remove-orphans api billing-worker media-cleanup web

wait_for_health api 90
wait_for_health web 60

"${compose[@]}" exec -T api python -c \
  "import json, urllib.request; data=json.load(urllib.request.urlopen('http://new-api:3000/api/status', timeout=10)); assert data.get('success') is True"

ln -sfn "$resolved_release" "$base_dir/current"
printf '%s\n' "$(basename "$resolved_release")" > "$shared_dir/active-release"

echo "miseStudio deployment completed: $(basename "$resolved_release")"
