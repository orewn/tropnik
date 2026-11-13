# PGDG PostGIS +2 was rebuilt against PostgreSQL 18.7 headers. The upstream
# postgis/postgis:18-3.7 image still contains PostgreSQL 18.6 and the older +1.
FROM postgres:18.7-trixie@sha256:9f4fd4aa918f52ae3d6f3b687f1de90d8f867cd4d520021545a9a50c120eae3b

LABEL org.opencontainers.image.source="https://github.com/orewn/tropnik" \
      org.opencontainers.image.description="PostgreSQL 18.7 with official PGDG PostGIS 3.7.0 rebuilt against 18.7 headers"

ENV POSTGIS_MAJOR=3 \
    POSTGIS_VERSION=3.7.0+dfsg-1.pgdg13+2

COPY packages.sha256 /tmp/postgis-packages/SHA256SUMS
RUN set -eu; \
    test "$(dpkg --print-architecture)" = amd64; \
    test "$PG_VERSION" = 18.7-1.pgdg13+2; \
    apt-get update; \
    cd /tmp/postgis-packages; \
    apt-get download "postgresql-18-postgis-3=$POSTGIS_VERSION" "postgresql-18-postgis-3-scripts=$POSTGIS_VERSION"; \
    sha256sum --check SHA256SUMS; \
    apt-get install -y --no-install-recommends \
      "postgresql-18=$PG_VERSION" "postgresql-client-18=$PG_VERSION" "libpq5=$PG_VERSION" \
      "./postgresql-18-postgis-3_${POSTGIS_VERSION}_amd64.deb" \
      "./postgresql-18-postgis-3-scripts_${POSTGIS_VERSION}_all.deb"; \
    test "$(dpkg-query -W -f='${Version}' postgresql-18)" = "$PG_VERSION"; \
    test "$(dpkg-query -W -f='${Version}' postgresql-18-postgis-3)" = "$POSTGIS_VERSION"; \
    test "$(dpkg-query -W -f='${Version}' postgresql-18-postgis-3-scripts)" = "$POSTGIS_VERSION"; \
    rm -rf /tmp/postgis-packages /var/lib/apt/lists/*

# Non-executable init script is sourced by the official PostgreSQL entrypoint,
# preserving its docker_process_sql/psql array and template_postgis semantics.
COPY --chmod=0644 initdb-postgis.sh /docker-entrypoint-initdb.d/10_postgis.sh
COPY --chmod=0755 update-postgis.sh /usr/local/bin/update-postgis.sh
COPY --chmod=0644 provenance.json runtime-check.sql /usr/local/share/tropnik/
COPY --chmod=0644 LICENSE /usr/local/share/doc/tropnik-postgis/LICENSE
