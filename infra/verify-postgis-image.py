#!/usr/bin/env python3
"""Qualify the shared PostgreSQL/PostGIS image using isolated synthetic data."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import time

INFRA = Path(__file__).resolve().parent
RUNTIME_CHECK = "/usr/local/share/tropnik/runtime-check.sql"


def run(argv, *, timeout=60, check=True, env=None):
    result = subprocess.run(
        [str(arg) for arg in argv],
        cwd=INFRA.parent,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )
    if check and result.returncode:
        raise RuntimeError(
            f"{argv[0]} {argv[1]} failed ({result.returncode}): {result.stderr[-3000:]}"
        )
    return result


def compose(filename, *args, env=None):
    return run(
        ["docker", "compose", "--env-file", "/dev/null", "-f", INFRA / filename, *args],
        env=env,
        timeout=600 if args and args[0] == "build" else 60,
    )


def source_is_clean():
    return not run(["git", "status", "--porcelain", "--untracked-files=normal", "--",
                    "backend", "infra", ".github/workflows/backend.yml"]).stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if args.report.exists():
        raise RuntimeError("Refusing to overwrite image verification evidence")
    if not args.report.parent.is_dir():
        raise RuntimeError("The report directory must already exist")
    source_commit = run(["git", "rev-parse", "HEAD"]).stdout.strip()
    source_tree = run(["git", "rev-parse", "HEAD^{tree}"]).stdout.strip()
    if not source_is_clean():
        raise RuntimeError("Image qualification requires committed backend, infra and workflow sources")

    expected_raw = (INFRA / "db/postgis/provenance.json").read_bytes()
    expected = json.loads(expected_raw)
    # Render configuration with explicit fixture values; no real .env is read.
    fixture_env = dict(os.environ)
    fixture_env.update({
        "POSTGRES_PASSWORD": "configuration-fixture",
        "TROPA_APP_PASSWORD": "configuration-fixture",
        "PUBLIC_ORIGIN": "https://fixture.tropnik.invalid",
        "TROPA_AUTH_RATE_KEY": "11" * 32,
        "TROPA_SAFETY_DATA_KEY": "22" * 32,
        "TROPA_ACCOUNT_MAIL_KEY": "",
        "TROPA_TEST_PASSWORD": "configuration-fixture",
        "TROPA_DRILL_PASSWORD": "configuration-fixture",
        "TROPA_DRILL_DATABASE": "postgres",
        "TROPA_DRILL_PURPOSE": "restore",
    })
    shared = json.loads(compose("compose.database.yaml", "config", "--format", "json").stdout)["services"]["postgis"]
    for stack in ("compose.yaml", "compose.test.yaml", "compose.restore.yaml"):
        database = json.loads(compose(stack, "config", "--format", "json", env=fixture_env).stdout)["services"]["db"]
        for key in ("image", "platform", "pull_policy", "build"):
            if database[key] != shared[key]:
                raise RuntimeError(f"{stack} does not use the shared database {key}")
    compose("compose.database.yaml", "build", "postgis")
    image = json.loads(run(["docker", "image", "inspect", shared["image"]]).stdout)[0]
    if image["Os"] != "linux" or image["Architecture"] != "amd64":
        raise RuntimeError("The verified database package requires linux/amd64")

    container = "tropa-image-gate-" + secrets.token_hex(8)
    password_env = dict(os.environ)
    password_env["POSTGRES_PASSWORD"] = secrets.token_hex(32)
    report = {
        "schemaVersion": 1,
        "status": "passed",
        "sourceCommit": source_commit,
        "sourceTree": source_tree,
        "sourceTreeClean": True,
        "image": shared["image"],
        "imageId": image["Id"],
        "platform": "linux/amd64",
        "provenanceSHA256": hashlib.sha256(expected_raw).hexdigest(),
        "provenance": expected,
        "composeStacksVerified": ["compose.yaml", "compose.test.yaml", "compose.restore.yaml"],
    }

    def sql(query=None, *, database="tropa_image", check=True, extra=()):
        argv = ["docker", "exec", container, "psql", "-XqAt", "-v", "ON_ERROR_STOP=1",
                "-U", "tropa_image", "-d", database]
        if query is not None:
            argv += ["-c", query]
        return run(argv + list(extra), check=check)

    primary_error = None
    try:
        run(["docker", "run", "--detach", "--name", container, "--platform", "linux/amd64",
             "--network", "none", "--log-driver", "none",
             "--tmpfs", "/var/lib/postgresql:rw,size=1073741824",
             "--memory", "2g", "--pids-limit", "256", "--shm-size", "256m",
             "--security-opt", "no-new-privileges:true",
             "-e", "POSTGRES_USER=tropa_image", "-e", "POSTGRES_DB=tropa_image",
             "-e", "POSTGRES_PASSWORD", image["Id"]], env=password_env)
        state = json.loads(run(["docker", "inspect", container]).stdout)[0]
        host = state["HostConfig"]
        if (host["NetworkMode"] != "none" or host["LogConfig"]["Type"] != "none"
                or host["PortBindings"] or host["Binds"]
                or "/var/lib/postgresql" not in host["Tmpfs"]
                or any(mount["Type"] != "tmpfs" for mount in state["Mounts"])):
            raise RuntimeError("Image fixture isolation does not match its contract")
        report["containerIsolationVerified"] = True
        deadline = time.monotonic() + 90
        while run(["docker", "exec", container, "pg_isready", "-h", "127.0.0.1",
                   "-U", "tropa_image", "-d", "tropa_image"], check=False).returncode:
            if time.monotonic() >= deadline:
                raise RuntimeError("The final database TCP listener did not become ready")
            time.sleep(1)
        sql(extra=("-f", RUNTIME_CHECK))
        sql(database="template_postgis", extra=("-f", RUNTIME_CHECK))
        for database in ("tropa_image", "template_postgis"):
            extensions = sql("SELECT string_agg(extname,',' ORDER BY extname) FROM pg_extension WHERE extname LIKE 'postgis%'", database=database).stdout.strip()
            if extensions != "postgis,postgis_topology":
                raise RuntimeError("Upstream default/template PostGIS initialization changed")

        image_provenance = run(["docker", "exec", container, "cat", "/usr/local/share/tropnik/provenance.json"]).stdout.encode()
        if image_provenance != expected_raw:
            raise RuntimeError("The running image does not contain the reviewed provenance")
        report["librarySHA256"] = {}
        for name, wanted in expected["librarySHA256"].items():
            actual = run(["docker", "exec", container, "sha256sum", "/usr/lib/postgresql/18/lib/" + name]).stdout.split()[0]
            if actual != wanted:
                raise RuntimeError("An installed PostGIS library differs from the verified PGDG rebuild")
            report["librarySHA256"][name] = actual
        for package in ("postgresql-18", "postgresql-client-18", "libpq5",
                        "postgresql-18-postgis-3", "postgresql-18-postgis-3-scripts"):
            version = run(["docker", "exec", container, "dpkg-query", "-W", "-f=${Version}", package]).stdout
            wanted = expected["postgisPackageVersion"] if "-postgis-" in package else expected["postgresPackageVersion"]
            if version != wanted:
                raise RuntimeError("An installed database package differs from the verified version")

        # Run the optional extension libraries as well as their CREATE EXTENSION
        # scripts. Everything below is synthetic and rolls back.
        smoke = sql("""
            BEGIN;
            CREATE EXTENSION postgis_raster;
            CREATE EXTENSION postgis_sfcgal;
            CREATE TEMP TABLE image_feature(id integer, geom geometry(Point,4326));
            INSERT INTO image_feature VALUES (1,ST_SetSRID(ST_Point(1,2),4326));
            DO $check$
            BEGIN
                IF (SELECT ST_AsGeoJSON(f)::jsonb->'geometry'->>'type' FROM image_feature f) IS DISTINCT FROM 'Point' THEN
                    RAISE EXCEPTION 'PostGIS composite-record geometry smoke failed';
                END IF;
                PERFORM topology.CreateTopology('image_gate_topology',4326);
                IF ST_Value(ST_AddBand(ST_MakeEmptyRaster(1,1,0,0,1,-1,0,0,4326),'8BUI'::text,7,0),1,1,1) IS DISTINCT FROM 7 THEN
                    RAISE EXCEPTION 'PostGIS raster smoke failed';
                END IF;
                IF (abs(CG_3DArea(ST_GeomFromText('POLYGON Z ((0 0 0,1 0 0,0 1 0,0 0 0))'))-0.5) <= 0.000001) IS DISTINCT FROM true THEN
                    RAISE EXCEPTION 'PostGIS SFCGAL smoke failed';
                END IF;
            END;
            $check$;
            SELECT json_build_object(
                'serverVersion',current_setting('server_version'),
                'serverVersionNum',current_setting('server_version_num')::integer,
                'compositeTypeMismatch',current_setting('composite_type_mismatch'),
                'dataDirectory',current_setting('data_directory'),
                'postgisFullVersion',postgis_full_version(),
                'extensionVersions',(SELECT json_object_agg(extname,extversion) FROM pg_extension WHERE extname LIKE 'postgis%')
            )::text;
            ROLLBACK;
        """)
        report["runtime"] = json.loads(smoke.stdout.strip())
        if report["runtime"]["dataDirectory"] != "/var/lib/postgresql/18/docker":
            raise RuntimeError("PostgreSQL data directory semantics changed")
        report["unsafeSettingsRejected"] = []
        report["unsafeSettingGuardEvidence"] = {}
        for unsafe in ("warn", "disabled"):
            rejected = sql(f"SET composite_type_mismatch='{unsafe}'; SELECT current_setting('composite_type_mismatch')",
                           check=False, extra=("-f", RUNTIME_CHECK))
            diagnostic = "composite type mismatch protection must remain strict"
            if (rejected.stdout.strip() != unsafe or rejected.returncode == 0
                    or diagnostic not in rejected.stderr):
                raise RuntimeError("The unsafe-setting case did not reach and fail the strict runtime guard")
            report["unsafeSettingsRejected"].append(unsafe)
            report["unsafeSettingGuardEvidence"][unsafe] = {
                "observedBeforeGuard": rejected.stdout.strip(),
                "guardDiagnostic": diagnostic,
            }
        sql(extra=("-f", RUNTIME_CHECK))
        report["checks"] = {
            "sharedComposeDefinition": True, "officialRebuiltLibraries": True,
            "strictCompositeTypeChecks": True, "upstreamTemplateInitialization": True,
            "geometryRecord": True, "topology": True, "raster": True, "sfcgal": True,
        }
    except BaseException as error:
        primary_error = error
        raise
    finally:
        try:
            run(["docker", "rm", "--force", "--volumes", container])
        except Exception as cleanup_error:
            if primary_error is None:
                raise
            primary_error.add_note(f"Fixture cleanup also failed: {cleanup_error}")
    report["temporaryDatabaseRemovedBeforePublication"] = True
    if not source_is_clean() or run(["git", "rev-parse", "HEAD"]).stdout.strip() != source_commit:
        raise RuntimeError("Source changed during image qualification; refusing a mismatched receipt")
    with args.report.open("x", encoding="utf-8") as target:
        json.dump(report, target, ensure_ascii=False, indent=2)
        target.write("\n")
    print("PASS: verified PostgreSQL/PostGIS packages, strict runtime, all extension families and cleanup.")


if __name__ == "__main__":
    main()
