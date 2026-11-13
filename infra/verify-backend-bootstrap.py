#!/usr/bin/env python3
"""Build and start the production API path using disposable CI fixtures only."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

INFRA = Path(__file__).resolve().parent


def run(argv, *, timeout=60, check=True, env=None, public_error=False):
    result = subprocess.run([str(arg) for arg in argv], cwd=INFRA.parent, env=env,
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout)
    if check and result.returncode:
        detail = result.stderr[-3000:] if public_error else "fixture command failed; no environment or container logs exported"
        raise RuntimeError(f"{argv[0]} {argv[1]} failed ({result.returncode}): {detail}")
    return result


def source_is_clean():
    return not run(["git", "status", "--porcelain", "--untracked-files=normal", "--",
                    "backend", "infra", ".github/workflows/backend.yml"]).stdout.strip()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--database-image-report", type=Path, required=True)
    args = parser.parse_args()
    if args.report.exists() or not args.report.parent.is_dir():
        raise RuntimeError("A new report path in an existing directory is required")
    source_commit = run(["git", "rev-parse", "HEAD"]).stdout.strip()
    source_tree = run(["git", "rev-parse", "HEAD^{tree}"]).stdout.strip()
    if not source_is_clean():
        raise RuntimeError("Bootstrap qualification requires committed backend, infra and workflow sources")
    image_proof = json.loads(args.database_image_report.read_text())
    if (image_proof.get("status") != "passed" or image_proof.get("sourceCommit") != source_commit
            or image_proof.get("sourceTree") != source_tree or not image_proof.get("sourceTreeClean")
            or image_proof.get("checks", {}).get("officialRebuiltLibraries") is not True):
        raise RuntimeError("A successful image qualification for this exact source is required")
    required_go = next(line.split()[1] for line in (INFRA.parent / "backend/go.mod").read_text().splitlines()
                       if line.startswith("go "))
    project = "tropa-bootstrap-" + secrets.token_hex(8)
    image_name = project + ":api"
    copy_container = project + "-binaries"
    report = {"schemaVersion": 1, "status": "passed",
              "scope": "disposable production Compose bootstrap; no live service deployment",
              "sourceCommit": source_commit, "sourceTree": source_tree, "sourceTreeClean": True,
              "binaries": {}}
    # Only image names differ from compose.yaml. Its ports, user, filesystem,
    # capabilities, healthcheck, network and role/migration configuration remain.
    with tempfile.TemporaryDirectory(prefix="tropa-bootstrap-") as temp:
        work = Path(temp)
        values = {
            "POSTGRES_PASSWORD": secrets.token_hex(32),
            "TROPA_APP_PASSWORD": secrets.token_hex(32),
            "PUBLIC_ORIGIN": "https://fixture.tropnik.invalid",
            "TROPA_AUTH_RATE_KEY": secrets.token_hex(32),
            "TROPA_SAFETY_DATA_KEY": secrets.token_hex(32),
            "TROPA_ACCOUNT_MAIL_KEY": secrets.token_hex(32),
            "TRUSTED_PROXY_CIDRS": "",
            "TROPA_PROXY_TOKEN": "",
        }
        env_file = work / "fixture.env"
        env_file.write_text("".join(key + "=" + value + "\n" for key, value in values.items()))
        env_file.chmod(0o600)
        overlay = work / "images.yaml"
        overlay.write_text("services:\n  api:\n    image: " + image_name + "\n  migrate:\n    image: " + image_name + "\n")
        fixture_env = dict(os.environ)
        fixture_env.update(values)
        base = ["docker", "compose", "--project-name", project, "--env-file", env_file,
                "--file", INFRA / "compose.yaml"]
        merged = base + ["--file", overlay]

        def compose(*args, timeout=60, public_error=False):
            return run(merged + list(args), env=fixture_env, timeout=timeout, public_error=public_error)

        def remaining_resources():
            return {
                "containers": run(["docker", "ps", "-aq", "--filter", "label=com.docker.compose.project=" + project]).stdout.strip(),
                "networks": run(["docker", "network", "ls", "-q", "--filter", "label=com.docker.compose.project=" + project]).stdout.strip(),
                "volumes": run(["docker", "volume", "ls", "-q", "--filter", "label=com.docker.compose.project=" + project]).stdout.strip(),
            }

        if any(remaining_resources().values()):
            raise RuntimeError("The randomly named fixture project is not empty")
        original = json.loads(run(base + ["config", "--format", "json"], env=fixture_env).stdout)
        actual = json.loads(compose("config", "--format", "json").stdout)
        for service in original["services"]:
            before = original["services"][service].copy()
            after = actual["services"][service].copy()
            if service in ("api", "migrate"):
                before.pop("image")
                after.pop("image")
            if before != after:
                raise RuntimeError("The bootstrap overlay changed production runtime configuration")
        report["productionConfigurationPreserved"] = True
        compose("build", "api", timeout=600, public_error=True)
        image = json.loads(run(["docker", "image", "inspect", image_name]).stdout)[0]
        if image["Os"] != "linux" or image["Architecture"] != "amd64":
            raise RuntimeError("The production build does not match the verified platform")
        report["apiImageId"] = image["Id"]
        report["platform"] = "linux/amd64"
        copy_exists = False
        stack_attempted = False
        primary_error = None
        try:
            copy_exists = True
            run(["docker", "create", "--name", copy_container, "--network", "none",
                 "--entrypoint", "/tropa-health", image["Id"]])
            for name in ("tropa-api", "tropa-migrate", "tropa-admin", "tropa-health"):
                target = work / name
                run(["docker", "cp", copy_container + ":/" + name, target])
                metadata = run(["go", "version", "-m", target]).stdout.splitlines()
                toolchain = metadata[0].rsplit(": ", 1)[-1]
                fields = [line.strip().split("\t") for line in metadata[1:]]
                package = next((field[1] for field in fields if field[0] == "path"), None)
                settings = dict(field[1].split("=", 1) for field in fields if field[0] == "build" and "=" in field[1])
                if (toolchain != "go" + required_go or package != "tropa/backend/cmd/" + name
                        or settings.get("CGO_ENABLED") != "0"
                        or settings.get("GOOS") != "linux" or settings.get("GOARCH") != "amd64"):
                    raise RuntimeError("A shipped binary has unexpected package/toolchain/build settings")
                report["binaries"][name] = {
                    "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                    "bytes": target.stat().st_size, "goVersion": toolchain,
                    "package": package, "cgoEnabled": False,
                    "goos": settings["GOOS"], "goarch": settings["GOARCH"],
                }
            run(["docker", "rm", "--volumes", copy_container])
            copy_exists = False
            stack_attempted = True
            compose("up", "-d", timeout=180)

            def inspect(service):
                identifier = compose("ps", "-aq", service).stdout.strip()
                if not identifier or "\n" in identifier:
                    raise RuntimeError("A fixture service did not create exactly one container")
                state = json.loads(run(["docker", "inspect", identifier]).stdout)[0]
                labels = state["Config"]["Labels"]
                if labels.get("com.docker.compose.project") != project or labels.get("com.docker.compose.service") != service:
                    raise RuntimeError("A fixture container does not belong to this project")
                return identifier, state

            api_id, api = inspect("api")
            migrate_id, migration = inspect("migrate")
            db_id, database = inspect("db")
            if database["Image"] != image_proof["imageId"]:
                raise RuntimeError("Production bootstrap did not use the qualified PostgreSQL/PostGIS image")
            if migration["State"]["Status"] != "exited" or migration["State"]["ExitCode"] != 0:
                raise RuntimeError("The actual migration binary did not finish successfully")
            if api["Image"] != image["Id"] or migration["Image"] != image["Id"]:
                raise RuntimeError("Bootstrap services did not use the built API image")
            bindings = api["NetworkSettings"]["Ports"].get("8080/tcp", [])
            if len(bindings) != 1 or bindings[0]["HostIp"] != "127.0.0.1":
                raise RuntimeError("The production API port is not loopback-only")
            if database["HostConfig"]["PortBindings"]:
                raise RuntimeError("The production database unexpectedly publishes a host port")
            origin = "http://127.0.0.1:" + bindings[0]["HostPort"]
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            deadline = time.monotonic() + 60
            while True:
                try:
                    with opener.open(origin + "/api/v1/health/ready", timeout=2) as response:
                        ready = response.status == 200 and json.loads(response.read(8193)) == {"status": "ready"}
                except (OSError, ValueError, urllib.error.HTTPError):
                    ready = False
                api_id, api = inspect("api")
                if ready and api["State"].get("Health", {}).get("Status") == "healthy":
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError("The production API did not become HTTP/Docker ready")
                time.sleep(1)
            with opener.open(origin + "/api/v1/health/live", timeout=2) as response:
                if response.status != 200 or json.loads(response.read(8193)) != {"status": "ok"}:
                    raise RuntimeError("The production liveness endpoint failed")
            run(["docker", "exec", api_id, "/tropa-health"])
            host = api["HostConfig"]
            if (api["Config"]["User"] != "65532:65532" or not host["ReadonlyRootfs"]
                    or "ALL" not in host["CapDrop"]
                    or "no-new-privileges:true" not in host["SecurityOpt"]):
                raise RuntimeError("The API runtime hardening differs from production configuration")
            pid = api["State"]["Pid"]
            if type(pid) is not int or pid <= 1 or not api["State"]["Running"]:
                raise RuntimeError("The fixture API has no valid running host process")
            proc_reads = {}

            def read_fixture_proc(leaf):
                if leaf not in ("status", "mountinfo"):
                    raise RuntimeError("Unexpected fixture process inspection")
                path = Path("/proc") / str(pid) / leaf
                try:
                    contents = path.read_text()
                    proc_reads[leaf] = "direct"
                except PermissionError:
                    # The runner UID differs from the deliberately unprivileged
                    # API UID. Elevate only this read of its two validated paths.
                    contents = run(["sudo", "-n", "cat", path]).stdout
                    proc_reads[leaf] = "sudo-read-only"
                return contents

            kernel = dict(line.split(":", 1) for line in read_fixture_proc("status").splitlines() if ":" in line)
            if (set(kernel["Uid"].split()) != {"65532"} or set(kernel["Gid"].split()) != {"65532"}
                    or int(kernel["CapEff"].strip(), 16) != 0 or kernel["NoNewPrivs"].strip() != "1"):
                raise RuntimeError("The running API process does not enforce its unprivileged policy")
            root_mounts = [line.split() for line in read_fixture_proc("mountinfo").splitlines()
                           if line.split()[4] == "/"]
            if len(root_mounts) != 1 or "ro" not in root_mounts[0][5].split(","):
                raise RuntimeError("The running API root filesystem is not read-only")
            _, after_kernel_check = inspect("api")
            if not after_kernel_check["State"]["Running"] or after_kernel_check["State"]["Pid"] != pid:
                raise RuntimeError("The API process changed during kernel policy inspection")
            report["kernelProcReadMethods"] = proc_reads
            networks = api["NetworkSettings"]["Networks"]
            if len(networks) != 1:
                raise RuntimeError("The API has an unexpected network attachment")
            network = json.loads(run(["docker", "network", "inspect", next(iter(networks))]).stdout)[0]
            if not network["Internal"] or network["Labels"].get("com.docker.compose.project") != project:
                raise RuntimeError("The API database network is not the private fixture network")
            run(["docker", "exec", db_id, "psql", "-XqAt", "-U", "tropa_owner", "-d", "tropa",
                 "-f", "/usr/local/share/tropnik/runtime-check.sql"])
            query = """
                SELECT json_build_object(
                    'migrations',(SELECT json_agg(version ORDER BY version) FROM schema_migrations),
                    'runtimeRole',(SELECT json_build_object('superuser',rolsuper,'createDB',rolcreatedb,
                         'createRole',rolcreaterole,'replication',rolreplication) FROM pg_roles WHERE rolname='tropa_app'),
                    'runtimeConnections',(SELECT count(*) FROM pg_stat_activity WHERE usename='tropa_app' AND datname='tropa'),
                    'postgresVersion',current_setting('server_version'),
                    'compositeTypeMismatch',current_setting('composite_type_mismatch'),
                    'postgisVersion',postgis_lib_version()
                )::text
            """
            db_proof = json.loads(run(["docker", "exec", db_id, "psql", "-XqAt", "-v", "ON_ERROR_STOP=1",
                                      "-U", "tropa_owner", "-d", "tropa", "-c", query]).stdout)
            if (db_proof["migrations"] != list(range(1, 9)) or db_proof["runtimeRole"] is None
                    or any(db_proof["runtimeRole"].values()) or db_proof["runtimeConnections"] < 1):
                raise RuntimeError("Schema or runtime-role bootstrap did not complete")
            report["database"] = db_proof
            report["databaseImageId"] = database["Image"]
            report["runtime"] = {"uid": 65532, "gid": 65532, "effectiveCapabilities": 0,
                                 "noNewPrivileges": True, "readOnlyRootFilesystem": True,
                                 "internalDatabaseNetwork": True, "apiLoopbackOnly": True,
                                 "databasePortUnpublished": True, "migrationExitCode": 0,
                                 "httpLive": "ok", "httpReady": "ready", "healthBinarySucceeded": True}
        except BaseException as error:
            primary_error = error
            raise
        finally:
            cleanup_errors = []
            if copy_exists:
                try:
                    run(["docker", "rm", "--force", "--volumes", copy_container])
                except Exception as error:
                    cleanup_errors.append(error)
            if stack_attempted:
                try:
                    compose("down", "--volumes", "--remove-orphans", timeout=90)
                    if any(remaining_resources().values()):
                        raise RuntimeError("Fixture project resources survived teardown")
                except Exception as error:
                    cleanup_errors.append(error)
            if cleanup_errors:
                if primary_error is None:
                    raise RuntimeError("Fixture teardown failed; no success receipt published") from cleanup_errors[0]
                for error in cleanup_errors:
                    primary_error.add_note(f"Fixture teardown also failed: {error}")
    if work.exists():
        raise RuntimeError("Fixture files survived their private temporary directory")
    if not source_is_clean() or run(["git", "rev-parse", "HEAD"]).stdout.strip() != source_commit:
        raise RuntimeError("Source changed during bootstrap; refusing a mismatched receipt")
    report["cleanup"] = {"containersRemoved": True, "networkRemoved": True,
                         "databaseVolumeRemoved": True, "fixtureSecretsAndBinariesRemoved": True}
    with args.report.open("x", encoding="utf-8") as output:
        json.dump(report, output, indent=2)
        output.write("\n")
    print("PASS: actual API Docker build, four Go binaries, production Compose bootstrap and cleanup.")


if __name__ == "__main__":
    main()
