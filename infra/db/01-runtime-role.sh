#!/bin/sh
set -eu
: "${TROPA_APP_PASSWORD:?Set a separate runtime database password}"
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL'
\getenv app_password TROPA_APP_PASSWORD
CREATE ROLE tropa_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
