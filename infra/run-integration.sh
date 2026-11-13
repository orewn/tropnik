#!/usr/bin/env bash
set -euo pipefail
TROPA_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TROPA_TEST_PROJECT="tropa-it-$$-${RANDOM}"
TROPA_TEST_PASSWORD="$(openssl rand -hex 32)"
export TROPA_TEST_PASSWORD
TROPA_GO="${TROPA_GO:-go}"
cleanup() {
  docker compose -p "$TROPA_TEST_PROJECT" -f "$TROPA_SCRIPT_DIR/compose.test.yaml" down --volumes >/dev/null
}
trap cleanup EXIT
docker compose -p "$TROPA_TEST_PROJECT" -f "$TROPA_SCRIPT_DIR/compose.test.yaml" up -d --wait
docker compose -p "$TROPA_TEST_PROJECT" -f "$TROPA_SCRIPT_DIR/compose.test.yaml" exec -T db \
  psql -X --quiet --no-password --username=tropa_test --dbname=tropa_test \
  --file=/usr/local/share/tropnik/runtime-check.sql
TROPA_TEST_ENDPOINT="$(docker compose -p "$TROPA_TEST_PROJECT" -f "$TROPA_SCRIPT_DIR/compose.test.yaml" port db 5432)"
TROPA_TEST_PORT="${TROPA_TEST_ENDPOINT##*:}"
export TEST_DATABASE_URL="postgres://tropa_test:${TROPA_TEST_PASSWORD}@127.0.0.1:${TROPA_TEST_PORT}/tropa_test?sslmode=disable"
cd -- "$TROPA_SCRIPT_DIR/../backend"
"$TROPA_GO" test -race -count=1 -v -tags=integration ./internal/store
