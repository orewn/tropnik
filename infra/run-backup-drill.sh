#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "$1" >&2; exit 1; }
TROPA_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
[[ $# == 2 && "$1" == --report && -n "$2" ]] || fail 'Usage: run-backup-drill.sh --report FILE.json'
TROPA_GATE_REPORT="$2"
for TROPA_TOOL in docker age age-keygen openssl python3 sha256sum mktemp sync; do
  command -v "$TROPA_TOOL" >/dev/null || fail 'A required recovery gate tool is unavailable; see infra/README.md.'
done
TROPA_REPORT_DIR="$(cd -- "$(dirname -- "$TROPA_GATE_REPORT")" && pwd -P)" || fail 'The report directory must already exist.'
TROPA_GATE_REPORT="$TROPA_REPORT_DIR/$(basename -- "$TROPA_GATE_REPORT")"
[[ ! -e "$TROPA_GATE_REPORT" && ! -L "$TROPA_GATE_REPORT" ]] || fail 'Refusing to overwrite recovery gate evidence.'
TROPA_WORK="$(mktemp -d "$TROPA_REPORT_DIR/.tropa-backup-gate.XXXXXXXXXX")"
TROPA_SOURCE_PROJECT="tropa-backup-it-$$-${RANDOM}-${RANDOM}"
TROPA_SOURCE=(docker compose --env-file /dev/null --project-name "$TROPA_SOURCE_PROJECT" --file "$TROPA_SCRIPT_DIR/compose.restore.yaml")
TROPA_SOURCE_STARTED=false
cleanup() {
  TROPA_EXIT_STATUS=$?
  trap - EXIT
  if [[ "$TROPA_SOURCE_STARTED" == true ]]; then
    if ! "${TROPA_SOURCE[@]}" down --volumes >/dev/null 2>&1; then
      printf '%s\n' 'The synthetic source stack could not be removed; inspect Docker recovery labels.' >&2
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
TROPA_DRILL_DATABASE=tropa_backup_test
TROPA_DRILL_PURPOSE=source
export TROPA_DRILL_PASSWORD TROPA_DRILL_DATABASE TROPA_DRILL_PURPOSE
assert_no_restore_resources() {
  TROPA_RESTORE_CONTAINERS="$(docker ps -aq --filter label=io.tropnik.recovery-purpose=restore)" || fail 'Could not inspect restore cleanup.'
  TROPA_RESTORE_NETWORKS="$(docker network ls -q --filter label=io.tropnik.recovery-purpose=restore)" || fail 'Could not inspect restore network cleanup.'
  [[ -z "$TROPA_RESTORE_CONTAINERS" && -z "$TROPA_RESTORE_NETWORKS" ]] || fail 'A temporary restore resource survived the drill.'
}
backup_fixture() {
  bash "$TROPA_SCRIPT_DIR/backup-postgres.sh" --compose-file "$TROPA_SCRIPT_DIR/compose.restore.yaml" \
    --project "$TROPA_SOURCE_PROJECT" --recipients "$TROPA_WORK/recipients.txt" --output "$1"
}
reject_restore() {
  if bash "$TROPA_SCRIPT_DIR/restore-drill.sh" --archive "$2" --identity "$3" --report "$TROPA_WORK/$1.json" >/dev/null 2>&1; then
    fail 'A negative restore case unexpectedly succeeded.'
  fi
  [[ ! -e "$TROPA_WORK/$1.json" ]] || fail 'A failed restore published a success report.'
  assert_no_restore_resources
}

# Both age identities and the database password are disposable CI data. They
# never appear in the resulting receipt or in uploaded artifacts.
age-keygen -o "$TROPA_WORK/identity.agekey" >/dev/null 2>&1
age-keygen -o "$TROPA_WORK/wrong-identity.agekey" >/dev/null 2>&1
age-keygen -y "$TROPA_WORK/identity.agekey" >"$TROPA_WORK/recipients.txt"
assert_no_restore_resources
TROPA_SOURCE_STARTED=true
"${TROPA_SOURCE[@]}" up -d --wait >/dev/null 2>&1 || fail 'Could not start the synthetic backup source.'
TROPA_SOURCE_CONTAINER="$("${TROPA_SOURCE[@]}" ps -q db)"
TROPA_SOURCE_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$TROPA_SOURCE_CONTAINER")"
TROPA_ISOLATION="$(docker inspect --format '{{.HostConfig.NetworkMode}}/{{len .HostConfig.PortBindings}}/{{len .HostConfig.Binds}}/{{.HostConfig.LogConfig.Type}}{{range .Mounts}}{{if ne .Type "tmpfs"}}/persistent-mount{{end}}{{end}}' "$TROPA_SOURCE_CONTAINER")"
[[ "$TROPA_ISOLATION" == none/0/0/none ]] || fail 'Synthetic source isolation does not match the recovery contract.'
for TROPA_MIGRATION in "$TROPA_SCRIPT_DIR"/../backend/migrations/[0-9][0-9][0-9]_*.sql; do
  "${TROPA_SOURCE[@]}" exec -T db psql -X --quiet --no-password --username=tropa_drill --dbname=tropa_backup_test --set=ON_ERROR_STOP=1 \
    <"$TROPA_MIGRATION" >/dev/null 2>&1 || fail 'A source migration failed in the synthetic recovery database.'
done
"${TROPA_SOURCE[@]}" exec -T db psql -X --quiet --no-password --username=tropa_drill --dbname=tropa_backup_test --set=ON_ERROR_STOP=1 \
  <"$TROPA_SCRIPT_DIR/backup-fixture.sql" >/dev/null 2>&1 || fail 'Could not create synthetic recovery fixtures.'

backup_fixture "$TROPA_WORK/fixture.age"
bash "$TROPA_SCRIPT_DIR/restore-drill.sh" --archive "$TROPA_WORK/fixture.age" --identity "$TROPA_WORK/identity.agekey" \
  --report "$TROPA_WORK/roundtrip.json" --verify-synthetic-fixture
assert_no_restore_resources
printf '%s\n' 'PASS: data, PostGIS geometry, safety ciphertext, event chain and sequence round trip.'

reject_restore wrong-identity "$TROPA_WORK/fixture.age" "$TROPA_WORK/wrong-identity.agekey"
python3 - "$TROPA_WORK/fixture.age" "$TROPA_WORK/truncated.age" <<'PY'
import shutil, sys
with open(sys.argv[1], 'rb') as source, open(sys.argv[2], 'xb') as target:
    shutil.copyfileobj(source, target)
    target.truncate(target.tell() - 1)
PY
reject_restore truncated "$TROPA_WORK/truncated.age" "$TROPA_WORK/identity.agekey"
TROPA_EXISTING_SHA="$(sha256sum "$TROPA_WORK/fixture.age")"
if backup_fixture "$TROPA_WORK/fixture.age" >/dev/null 2>&1; then
  fail 'Backup overwrote an existing destination.'
fi
[[ "$(sha256sum "$TROPA_WORK/fixture.age")" == "$TROPA_EXISTING_SHA" ]] || fail 'The existing encrypted backup changed.'

# Disable only this newly generated source database, producing a real pg_dump
# connection failure while age still receives EOF and could otherwise succeed.
"${TROPA_SOURCE[@]}" exec -T db psql -X --quiet --no-password --username=tropa_drill --dbname=postgres --set=ON_ERROR_STOP=1 \
  --command='ALTER DATABASE tropa_backup_test ALLOW_CONNECTIONS false' >/dev/null 2>&1
if backup_fixture "$TROPA_WORK/failed-producer.age" >/dev/null 2>&1; then
  fail 'Backup accepted an unsuccessful database export.'
fi
[[ ! -e "$TROPA_WORK/failed-producer.age" ]] || fail 'A failed database export published a backup.'
"${TROPA_SOURCE[@]}" exec -T db psql -X --quiet --no-password --username=tropa_drill --dbname=postgres --set=ON_ERROR_STOP=1 \
  --command='ALTER DATABASE tropa_backup_test ALLOW_CONNECTIONS true' >/dev/null 2>&1

# A complete, internally consistent data snapshot still must not pass if an
# application safety guard is absent from its schema.
"${TROPA_SOURCE[@]}" exec -T db psql -X --quiet --no-password --username=tropa_drill --dbname=tropa_backup_test --set=ON_ERROR_STOP=1 \
  --command='DROP TRIGGER departure_safety_start_guard ON departures' >/dev/null 2>&1
backup_fixture "$TROPA_WORK/missing-guard.age" >/dev/null
reject_restore missing-guard "$TROPA_WORK/missing-guard.age" "$TROPA_WORK/identity.agekey"
"${TROPA_SOURCE[@]}" exec -T db psql -X --quiet --no-password --username=tropa_drill --dbname=tropa_backup_test --set=ON_ERROR_STOP=1 \
  --command='CREATE TRIGGER departure_safety_start_guard BEFORE UPDATE OF status ON departures FOR EACH ROW EXECUTE FUNCTION enforce_required_safety_before_start()' >/dev/null 2>&1

# A present trigger with the expected function is insufficient when it no
# longer observes status changes. Test both the operation and UPDATE columns.
for TROPA_GUARD_CASE in wrong-guard-event wrong-guard-column; do
  if [[ "$TROPA_GUARD_CASE" == wrong-guard-event ]]; then
    TROPA_GUARD_EVENT='INSERT'
  else
    TROPA_GUARD_EVENT='UPDATE OF guide_id'
  fi
  "${TROPA_SOURCE[@]}" exec -T db psql -X --quiet --no-password --username=tropa_drill --dbname=tropa_backup_test --set=ON_ERROR_STOP=1 \
    --command="DROP TRIGGER departure_safety_start_guard ON departures; CREATE TRIGGER departure_safety_start_guard BEFORE $TROPA_GUARD_EVENT ON departures FOR EACH ROW EXECUTE FUNCTION enforce_required_safety_before_start()" >/dev/null 2>&1
  backup_fixture "$TROPA_WORK/$TROPA_GUARD_CASE.age" >/dev/null
  reject_restore "$TROPA_GUARD_CASE" "$TROPA_WORK/$TROPA_GUARD_CASE.age" "$TROPA_WORK/identity.agekey"
done
"${TROPA_SOURCE[@]}" exec -T db psql -X --quiet --no-password --username=tropa_drill --dbname=tropa_backup_test --set=ON_ERROR_STOP=1 \
  --command='DROP TRIGGER departure_safety_start_guard ON departures; CREATE TRIGGER departure_safety_start_guard BEFORE UPDATE OF status ON departures FOR EACH ROW EXECUTE FUNCTION enforce_required_safety_before_start()' >/dev/null 2>&1

# A readable schema without the durable mail queue must not qualify recovery.
"${TROPA_SOURCE[@]}" exec -T db psql -X --quiet --no-password --username=tropa_drill --dbname=tropa_backup_test --set=ON_ERROR_STOP=1 \
  --command='ALTER TABLE account_mail_outbox RENAME TO missing_mail_outbox_fixture' >/dev/null 2>&1
backup_fixture "$TROPA_WORK/missing-mail-outbox.age" >/dev/null
reject_restore missing-mail-outbox "$TROPA_WORK/missing-mail-outbox.age" "$TROPA_WORK/identity.agekey"
"${TROPA_SOURCE[@]}" exec -T db psql -X --quiet --no-password --username=tropa_drill --dbname=tropa_backup_test --set=ON_ERROR_STOP=1 \
  --command='ALTER TABLE missing_mail_outbox_fixture RENAME TO account_mail_outbox' >/dev/null 2>&1

# Schema 8 requires the active-only count index, including its exact predicate.
# A present but narrower index must not pass merely because it is valid.
"${TROPA_SOURCE[@]}" exec -T db psql -X --quiet --no-password --username=tropa_drill --dbname=tropa_backup_test --set=ON_ERROR_STOP=1 \
  --command='DROP INDEX memberships_active_departure' >/dev/null 2>&1
backup_fixture "$TROPA_WORK/missing-active-index.age" >/dev/null
reject_restore missing-active-index "$TROPA_WORK/missing-active-index.age" "$TROPA_WORK/identity.agekey"
"${TROPA_SOURCE[@]}" exec -T db psql -X --quiet --no-password --username=tropa_drill --dbname=tropa_backup_test --set=ON_ERROR_STOP=1 \
  --command="CREATE INDEX memberships_active_departure ON memberships(departure_id) WHERE status='confirmed'" >/dev/null 2>&1
backup_fixture "$TROPA_WORK/wrong-active-index.age" >/dev/null
reject_restore wrong-active-index "$TROPA_WORK/wrong-active-index.age" "$TROPA_WORK/identity.agekey"
"${TROPA_SOURCE[@]}" exec -T db psql -X --quiet --no-password --username=tropa_drill --dbname=tropa_backup_test --set=ON_ERROR_STOP=1 \
  --command="DROP INDEX memberships_active_departure; CREATE INDEX memberships_active_departure ON memberships(departure_id) WHERE status IN ('confirmed','checked_in','completed')" >/dev/null 2>&1

# This is valid age ciphertext and a valid pg_dump archive, but not the required
# schema. It must fail verification after restore and still remove the stack.
"${TROPA_SOURCE[@]}" exec -T db psql -X --quiet --no-password --username=tropa_drill --dbname=tropa_backup_test --set=ON_ERROR_STOP=1 \
  --command='DELETE FROM schema_migrations WHERE version=8' >/dev/null 2>&1
backup_fixture "$TROPA_WORK/unsupported-schema.age" >/dev/null
reject_restore unsupported-schema "$TROPA_WORK/unsupported-schema.age" "$TROPA_WORK/identity.agekey"
if compgen -G "$TROPA_WORK/.tropa-backup.*" >/dev/null || compgen -G "$TROPA_WORK/.tropa-restore.*" >/dev/null; then
  fail 'A backup or restore temporary directory survived an error path.'
fi
printf '%s\n' 'PASS: wrong identity, truncated ciphertext, existing output, failed export, missing or incorrectly attached safety guards, missing mail outbox, missing or incorrect active index and unsupported schema refused.'

"${TROPA_SOURCE[@]}" down --volumes >/dev/null 2>&1 || fail 'Could not remove the synthetic source stack.'
TROPA_SOURCE_STARTED=false
assert_no_restore_resources
TROPA_REMAINING_SOURCE="$(docker ps -aq --filter "label=com.docker.compose.project=$TROPA_SOURCE_PROJECT")"
TROPA_REMAINING_NETWORK="$(docker network ls -q --filter "label=com.docker.compose.project=$TROPA_SOURCE_PROJECT")"
[[ -z "$TROPA_REMAINING_SOURCE" && -z "$TROPA_REMAINING_NETWORK" ]] || fail 'A synthetic source resource survived the drill.'
rm -f -- "$TROPA_WORK/identity.agekey" "$TROPA_WORK/wrong-identity.agekey"
[[ ! -e "$TROPA_WORK/identity.agekey" && ! -e "$TROPA_WORK/wrong-identity.agekey" ]] || fail 'Could not remove disposable age identities.'
python3 - "$TROPA_WORK/roundtrip.json" "$TROPA_WORK/gate.json" "$TROPA_SOURCE_IMAGE_ID" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as source:
    receipt = json.load(source)
assert receipt['status'] == 'passed' and receipt['syntheticFixtureVerified'] is True
assert receipt['schemaVersion'] == 8 and receipt['applicationTableCount'] == 32
assert receipt['checks']['mailOutbox'] is True
assert receipt['checks']['activeMembershipIndex'] is True
assert receipt['applicationGuardCount'] == 16 and receipt['checks']['applicationGuards'] is True
assert receipt['postgisImageId'] == sys.argv[3], 'source and restore image changed during the gate'
receipt['gate'] = 'synthetic backup and isolated restore'
receipt['negativeCasesPassed'] = ['wrong_identity', 'truncated_ciphertext', 'existing_output', 'failed_pg_dump', 'missing_safety_guard', 'wrong_guard_event', 'wrong_guard_column', 'missing_mail_outbox', 'missing_active_index', 'wrong_active_index_predicate', 'unsupported_schema']
receipt['syntheticSourceRemoved'] = True
receipt['disposableAgeIdentitiesRemoved'] = True
with open(sys.argv[2], 'x', encoding='utf-8') as target:
    json.dump(receipt, target, ensure_ascii=False, indent=2)
    target.write('\n')
PY
sync -f "$TROPA_WORK/gate.json"
ln -T -- "$TROPA_WORK/gate.json" "$TROPA_GATE_REPORT" 2>/dev/null || fail 'Recovery gate report destination became unavailable.'
sync -f "$TROPA_REPORT_DIR"
printf '%s\n' 'PASS: encrypted recovery gate completed; synthetic stacks and disposable age identities removed.'
