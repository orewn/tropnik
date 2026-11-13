# PostgreSQL 18.7 / PostGIS 3.7.0 image

This small derived image uses the official PostgreSQL Debian Trixie image at
an exact digest and the official PGDG PostGIS packages at exact versions and
SHA-256 hashes. It does not compile or modify PostGIS.

The fresh-image probe on 2026-11-13 found PostgreSQL 18.6 and an October 30
PostGIS library in `postgis/postgis:18-3.7`. PGDG's
`3.7.0+dfsg-1.pgdg13+2` rebuild is compiled against
`postgresql-server-dev-18=18.7-1.pgdg13+1`. The separate package probe
authenticated its download through APT, matched both package hashes to the
published buildinfo, and found the new `DatumGetHeapTupleHeader` and
`heap_datum_check` references in the actual core library. See
[provenance.json](provenance.json) for the exact upstream and CI references.

This rebuild matters for
[PostgreSQL 18.7 / CVE-2026-6460](https://www.postgresql.org/docs/release/18.7/).
Updating only the server while keeping the old extension does not provide
the full fix. The shared runtime check requires
`composite_type_mismatch=error`; neither `warn` nor `disabled` is accepted.

`initdb-postgis.sh`, `update-postgis.sh` and `LICENSE` are unchanged copies
from [postgis/docker-postgis](https://github.com/postgis/docker-postgis/tree/0ff5ed710b024d26c004eef32533cb586edfd560/18-3.7).
The init script remains non-executable so the PostgreSQL entrypoint sources it.
The image preserves `template_postgis`, the default `postgis` and
`postgis_topology` extensions, raster/SFCGAL availability, the upstream
entrypoint, and `PGDATA=/var/lib/postgresql/18/docker`.

All three stacks extend `../../compose.database.yaml`. Image construction
uses the network to authenticate and download packages; restore database
containers still use `network_mode: none`. A build fails if a pinned package
is absent or its bytes change. The CI image gate checks the four installed
library hashes, actual server/client/package versions, strict mismatch
handling (including negative cases), template initialization, geometry,
topology, raster and SFCGAL before the application's native and recovery gates.

A future package or base update must replace the pins and their provenance,
then rerun the image/native/recovery gates. Do not reuse an 18.7-built
extension with an older PostgreSQL server. No production database is deployed
by this recipe or by its fixture checks.
