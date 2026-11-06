# Isolated PostgreSQL SQL compatibility check

This is an additional **serial** SQL check for environments without a native
PostgreSQL process. It does not satisfy the production database gate in
[`infra/run-integration.sh`](../../infra/run-integration.sh).

The exact npm dependencies are PGlite 0.5.15, pglite-socket 0.2.18 and the
experimental pglite-postgis 0.2.15 extension. The observed engine is PostgreSQL
18.6 / PostGIS 3.6.2; the deployment image targets native PostGIS 3.7.

## Run

Use Node 24 and the Go version declared in `backend/go.mod`:

```bash
cd tools/db-compat
npm ci --ignore-scripts --no-audit --no-fund
node run.mjs --suite serial --output /tmp/tropnik-sql-compat-report
```

`TROPA_GO` may specify an installed Go executable. Normal Go module caches and
proxy configuration are respected. `--suite auth` selects only the three
affected auth-counter, migration/readiness and runtime-grant scenarios.
`--project` can point to a review checkout; it defaults to this repository.

The tool copies only Go/module/SQL source into a new temporary directory. It
clones the existing serial integration test bodies without changing their
assertions and replaces **only the isolated database helper**. Each test uses
a fresh schema, one shared connection and the actual application migrations.
The original native integration helper and its fail-closed `_test` database
requirement remain untouched.

The socket listens only on an ephemeral `127.0.0.1` port, in the same process
tree as the Go test child. The helper refuses any engine not reporting PGlite.
No supplied production DSN is used. `TEST_DATABASE_URL` or an externally supplied
compatibility DSN causes an early refusal. The database is discarded after the
run. Reports contain engine versions, explicit test names, source hashes and
raw Go JSON test events. A missing or skipped selected test fails the run.

## Limits

PGlite's wire wrapper multiplexes one underlying session. Therefore concurrent
joins, simultaneous posting, the new two-pool auth budget test, native role login,
SCRAM/pg_hba, TLS, Docker startup, backup/restore and the deployed web/API/DB chain
are **not tested** here. The additional role test uses `SET ROLE`: it demonstrates
the SQL grants and privilege denials, not wire authentication. Do not point the
production API at this harness or change native integration gates to accept it.

The extension documentation marks PostGIS experimental. Its package includes
GPL-2.0-or-later PostGIS WASM and an Apache-2.0 wrapper. Only the pinned dependency
manifest/lockfile and original harness source belong in the project archive;
exclude `node_modules`, downloaded WASM, caches and temporary database state.

Primary documentation: [PGlite extensions](https://pglite.dev/extensions/),
[PGlite socket](https://pglite.dev/docs/pglite-socket),
[upstream repository](https://github.com/electric-sql/pglite).
