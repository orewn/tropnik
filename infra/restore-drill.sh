#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "$1" >&2; exit 1; }
TROPA_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TROPA_ARCHIVE=""
TROPA_IDENTITY=""
TROPA_REPORT=""
TROPA_FIXTURE=false
while (($#)); do
  case "$1" in
    --archive|--identity|--report)
      (($# >= 2)) || fail 'A restore option is missing its value.'
      case "$1" in
        --archive) TROPA_ARCHIVE="$2" ;;
        --identity) TROPA_IDENTITY="$2" ;;
        --report) TROPA_REPORT="$2" ;;
      esac
      shift 2 ;;
    --verify-synthetic-fixture) TROPA_FIXTURE=true; shift ;;
    *) fail 'Usage: restore-drill.sh --archive FILE.age --identity FILE --report FILE.json [--verify-synthetic-fixture]' ;;
  esac
done
[[ -f "$TROPA_ARCHIVE" && -r "$TROPA_ARCHIVE" && -s "$TROPA_ARCHIVE" ]] || fail 'A readable encrypted backup is required.'
[[ -f "$TROPA_IDENTITY" && -r "$TROPA_IDENTITY" ]] || fail 'An existing readable age identity file is required.'
[[ -n "$TROPA_REPORT" ]] || fail 'An explicit report destination is required.'
for TROPA_TOOL in docker age openssl sha256sum mktemp sync; do
  command -v "$TROPA_TOOL" >/dev/null || fail 'A required restore tool is unavailable; see infra/README.md.'
done
TROPA_REPORT_DIR="$(cd -- "$(dirname -- "$TROPA_REPORT")" && pwd -P)" || fail 'The report directory must already exist.'
TROPA_REPORT="$TROPA_REPORT_DIR/$(basename -- "$TROPA_REPORT")"
[[ ! -e "$TROPA_REPORT" && ! -L "$TROPA_REPORT" ]] || fail 'Refusing to overwrite an existing restore report.'
TROPA_WORK="$(mktemp -d "$TROPA_REPORT_DIR/.tropa-restore.XXXXXXXXXX")"
TROPA_RESTORE_PROJECT="tropa-restore-$$-${RANDOM}-${RANDOM}"
TROPA_COMPOSE=(docker compose --env-file /dev/null --project-name "$TROPA_RESTORE_PROJECT" --file "$TROPA_SCRIPT_DIR/compose.restore.yaml")
TROPA_STARTED=false
cleanup() {
  TROPA_EXIT_STATUS=$?
  trap - EXIT
  if [[ "$TROPA_STARTED" == true ]]; then
    if ! "${TROPA_COMPOSE[@]}" down --volumes >/dev/null 2>&1; then
      printf '%s\n' 'The isolated restore stack could not be removed; inspect Docker recovery labels.' >&2
      TROPA_EXIT_STATUS=1
    fi
  fi
  rm -rf -- "$TROPA_WORK"
  exit "$TROPA_EXIT_STATUS"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
TROPA_DRILL_PASSWORD="$(openssl rand -hex 32)"
TROPA_DRILL_DATABASE=postgres
TROPA_DRILL_PURPOSE=restore
export TROPA_DRILL_PASSWORD TROPA_DRILL_DATABASE TROPA_DRILL_PURPOSE

# Work on a private encrypted copy so both passes use the same bytes. Full age
# authentication precedes SQL execution: a failing decrypt may emit a verified
# prefix before discovering truncation. No decrypted dump is written to disk.
cp -- "$TROPA_ARCHIVE" "$TROPA_WORK/snapshot.age" 2>/dev/null || fail 'Could not stage the encrypted backup.'
if ! age --decrypt --identity "$TROPA_IDENTITY" "$TROPA_WORK/snapshot.age" >/dev/null 2>&1; then
  fail 'Backup authentication failed; no restore database was started.'
fi
TROPA_ARCHIVE_SHA="$(sha256sum "$TROPA_WORK/snapshot.age")"
TROPA_ARCHIVE_SHA="${TROPA_ARCHIVE_SHA%% *}"
TROPA_AGE_VERSION="$(age --version)"
TROPA_SOURCE_COMMIT="$(git -C "$TROPA_SCRIPT_DIR" rev-parse HEAD 2>/dev/null || printf unknown)"
TROPA_SOURCE_CLEAN=false
if [[ "$TROPA_SOURCE_COMMIT" != unknown ]]; then
  TROPA_SOURCE_STATUS="$(git -C "$TROPA_SCRIPT_DIR/.." status --porcelain --untracked-files=normal -- backend infra .github/workflows/backend.yml)"
  [[ -n "$TROPA_SOURCE_STATUS" ]] || TROPA_SOURCE_CLEAN=true
fi
TROPA_STARTED=true
"${TROPA_COMPOSE[@]}" up -d --wait >/dev/null 2>&1 || fail 'Could not start the isolated restore database.'
TROPA_DB_CONTAINER="$("${TROPA_COMPOSE[@]}" ps -q db)"
TROPA_POSTGIS_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$TROPA_DB_CONTAINER")"
TROPA_ISOLATION="$(docker inspect --format '{{.HostConfig.NetworkMode}}/{{len .HostConfig.PortBindings}}/{{len .HostConfig.Binds}}/{{.HostConfig.LogConfig.Type}}{{range .Mounts}}{{if ne .Type "tmpfs"}}/persistent-mount{{end}}{{end}}' "$TROPA_DB_CONTAINER")"
[[ "$TROPA_ISOLATION" == none/0/0/none ]] || fail 'Restore container isolation does not match the recovery contract.'
"${TROPA_COMPOSE[@]}" exec -T db psql -X --no-password --username=tropa_drill --dbname=postgres --set=ON_ERROR_STOP=1 \
  --command='CREATE DATABASE tropa_restore_test TEMPLATE template0' >/dev/null 2>&1 || fail 'Could not create the empty isolated restore database.'
if ! age --decrypt --identity "$TROPA_IDENTITY" "$TROPA_WORK/snapshot.age" 2>/dev/null |
  "${TROPA_COMPOSE[@]}" exec -T db pg_restore --no-password --username=tropa_drill --dbname=tropa_restore_test \
    --no-owner --no-privileges --single-transaction --exit-on-error >/dev/null 2>&1; then
  fail 'Restore failed; the isolated database will be removed.'
fi
if [[ "$TROPA_FIXTURE" == true ]]; then
  "${TROPA_COMPOSE[@]}" exec -T db psql -X --quiet --no-password --username=tropa_drill --dbname=tropa_restore_test --set=ON_ERROR_STOP=1 \
    <"$TROPA_SCRIPT_DIR/backup-fixture-check.sql" >/dev/null 2>&1 || fail 'Synthetic backup fixture verification failed.'
fi
# PostgreSQL may include row contents in error details. Keep those off both the
# host filesystem and CI logs; only the bounded result report leaves this stack.
"${TROPA_COMPOSE[@]}" exec -T db psql -X --quiet --tuples-only --no-align --no-password --username=tropa_drill --dbname=tropa_restore_test \
  --set=ON_ERROR_STOP=1 --set="archive_sha256=$TROPA_ARCHIVE_SHA" --set="age_version=$TROPA_AGE_VERSION" \
  --set="source_commit=$TROPA_SOURCE_COMMIT" --set="fixture_verified=$TROPA_FIXTURE" --set="postgis_image_id=$TROPA_POSTGIS_IMAGE_ID" \
  --set="source_tree_clean=$TROPA_SOURCE_CLEAN" \
  <"$TROPA_SCRIPT_DIR/restore-check.sql" >"$TROPA_WORK/report.json" 2>/dev/null || fail 'Restored schema or integrity checks failed.'
[[ -s "$TROPA_WORK/report.json" ]] || fail 'Restore verification produced no report.'
"${TROPA_COMPOSE[@]}" down --volumes >/dev/null 2>&1 || fail 'Could not remove the isolated restore stack.'
TROPA_STARTED=false
sync -f "$TROPA_WORK/report.json"
ln -T -- "$TROPA_WORK/report.json" "$TROPA_REPORT" 2>/dev/null || fail 'Restore report publication refused an existing or unavailable destination.'
sync -f "$TROPA_REPORT_DIR"
printf '%s\n' 'Isolated restore verified; temporary database removed.'
