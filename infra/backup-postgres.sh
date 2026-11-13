#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "$1" >&2; exit 1; }
TROPA_COMPOSE_FILE=""
TROPA_BACKUP_PROJECT=""
TROPA_ENV_FILE=""
TROPA_RECIPIENTS=""
TROPA_OUTPUT=""
while (($#)); do
  case "$1" in
    --compose-file|--project|--env-file|--recipients|--output)
      (($# >= 2)) || fail 'A backup option is missing its value.'
      case "$1" in
        --compose-file) TROPA_COMPOSE_FILE="$2" ;;
        --project) TROPA_BACKUP_PROJECT="$2" ;;
        --env-file) TROPA_ENV_FILE="$2" ;;
        --recipients) TROPA_RECIPIENTS="$2" ;;
        --output) TROPA_OUTPUT="$2" ;;
      esac
      shift 2 ;;
    *) fail 'Usage: backup-postgres.sh --compose-file FILE --project NAME [--env-file FILE] --recipients FILE --output FILE.age' ;;
  esac
done
[[ -f "$TROPA_COMPOSE_FILE" && -r "$TROPA_COMPOSE_FILE" ]] || fail 'An explicit readable Compose file is required.'
[[ "$TROPA_BACKUP_PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail 'An explicit Compose project name is required.'
[[ -f "$TROPA_RECIPIENTS" && -r "$TROPA_RECIPIENTS" ]] || fail 'A readable age recipients file is required.'
[[ -n "$TROPA_OUTPUT" ]] || fail 'An explicit destination file is required.'
[[ -z "$TROPA_ENV_FILE" || ( -f "$TROPA_ENV_FILE" && -r "$TROPA_ENV_FILE" ) ]] || fail 'The selected environment file is unavailable.'
for TROPA_TOOL in docker age mktemp sync; do
  command -v "$TROPA_TOOL" >/dev/null || fail 'A required backup tool is unavailable; see infra/README.md.'
done
TROPA_OUTPUT_DIR="$(cd -- "$(dirname -- "$TROPA_OUTPUT")" && pwd -P)" || fail 'The destination directory must already exist.'
TROPA_OUTPUT="$TROPA_OUTPUT_DIR/$(basename -- "$TROPA_OUTPUT")"
[[ ! -e "$TROPA_OUTPUT" && ! -L "$TROPA_OUTPUT" ]] || fail 'Refusing to overwrite an existing backup destination.'
TROPA_PARTIAL_DIR="$(mktemp -d "$TROPA_OUTPUT_DIR/.tropa-backup.XXXXXXXXXX")"
cleanup() { rm -rf -- "$TROPA_PARTIAL_DIR"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
TROPA_COMPOSE=(docker compose --project-name "$TROPA_BACKUP_PROJECT" --file "$TROPA_COMPOSE_FILE")
if [[ -n "$TROPA_ENV_FILE" ]]; then
  TROPA_COMPOSE+=(--env-file "$TROPA_ENV_FILE")
else
  # Do not discover credentials from an unrelated working-directory .env.
  TROPA_COMPOSE+=(--env-file /dev/null)
fi

# The selected database must already be running. Its existing owner credential
# stays inside that container; no connection URL or password becomes an argv.
# Only encrypted bytes reach the temporary file, even if pg_dump fails midway.
if ! "${TROPA_COMPOSE[@]}" exec -T db sh -eu -c '
  export PGPASSWORD="$POSTGRES_PASSWORD"
  exec pg_dump --no-password --format=custom --lock-wait-timeout=10000 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"
' 2>/dev/null | age --encrypt --recipients-file "$TROPA_RECIPIENTS" >"$TROPA_PARTIAL_DIR/snapshot.age" 2>/dev/null; then
  fail 'Database export or encryption failed; no backup was published.'
fi
[[ -s "$TROPA_PARTIAL_DIR/snapshot.age" ]] || fail 'Encryption produced no backup.'
sync -f "$TROPA_PARTIAL_DIR/snapshot.age"
# A same-filesystem hard link publishes the completed file atomically and fails
# if another process has already claimed the destination. mv -n can silently skip.
ln -T -- "$TROPA_PARTIAL_DIR/snapshot.age" "$TROPA_OUTPUT" 2>/dev/null || fail 'Backup publication refused an existing or unavailable destination.'
sync -f "$TROPA_OUTPUT_DIR"
printf '%s\n' 'Encrypted PostgreSQL snapshot completed.'
