#!/usr/bin/env python3
"""Build and start the production API path using disposable CI fixtures only."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
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


def health_response_matches(response, expected_status):
    """Require the API's real response envelope, not an unrelated HTTP 200."""
    if response.status != 200:
        return False
    payload = response.read(8193)
    if len(payload) > 8192:
        return False
    try:
        actual = json.loads(payload)
    except ValueError:
        return False
    return actual == {
        "data": {"status": expected_status},
        "meta": {"mode": "production"},
    }


def validate_production_topology(config, ingress_image, *, include_web=False, mail_enabled=False):
    """Check Compose's resolved topology before creating any fixture resources."""
    expected = {
        "db": {"backend"}, "migrate": {"backend"},
        "api": {"backend", "application"},
        "ingress": {"application", "frontend"},
    }
    if include_web:
        expected["web"] = {"application"}
    if mail_enabled:
        expected["api"].add("mail-egress")
    if set(config["services"]) != set(expected):
        raise RuntimeError("The production topology has an unexpected service")
    for service, networks in expected.items():
        actual = config["services"][service]
        if set(actual.get("networks", {})) != networks or actual.get("network_mode"):
            raise RuntimeError(f"The {service} service has an unexpected network attachment")
        if service != "ingress" and actual.get("ports"):
            raise RuntimeError(f"The {service} service must not publish a direct host port")
    expected_networks = {"backend": True, "application": True, "frontend": False}
    if mail_enabled:
        expected_networks["mail-egress"] = False
    if set(config["networks"]) != set(expected_networks):
        raise RuntimeError("The production topology has an unexpected network")
    for name, internal in expected_networks.items():
        network = config["networks"][name]
        if (bool(network.get("internal")) != internal or network.get("external")
                or network.get("driver") not in (None, "bridge")):
            raise RuntimeError(f"The {name} network does not match its isolation policy")
    ingress = config["services"]["ingress"]
    if ingress["image"] != ingress_image or ingress["platform"] != "linux/amd64":
        raise RuntimeError("The ingress does not use the reviewed image and platform")
    ports = sorted((int(p["target"]), str(p["published"]), p.get("host_ip"), p.get("protocol", "tcp"))
                   for p in ingress.get("ports", []))
    expected_ports = [(8080, "8080", "127.0.0.1", "tcp")]
    if include_web:
        expected_ports.append((3000, "3000", "127.0.0.1", "tcp"))
    if ports != sorted(expected_ports):
        raise RuntimeError("Only the ingress may publish the expected loopback HTTP ports")
    if (ingress.get("user") != "65532:65532" or ingress.get("read_only") is not True
            or set(ingress.get("cap_drop", [])) != {"ALL"}
            or "no-new-privileges:true" not in ingress.get("security_opt", [])):
        raise RuntimeError("The ingress runtime hardening is incomplete")
    required_dependencies = {"api": "service_healthy"}
    if include_web:
        required_dependencies["web"] = "service_healthy"
    dependencies = {name: value["condition"] for name, value in ingress.get("depends_on", {}).items()}
    if dependencies != required_dependencies:
        raise RuntimeError("The ingress must wait for its actual upstreams to become healthy")
    expected_mounts = {
        "/etc/caddy/Caddyfile": str(INFRA / "ingress/Caddyfile"),
        "/etc/caddy/listeners/api.caddy": str(INFRA / "ingress/api.caddy"),
    }
    if include_web:
        expected_mounts["/etc/caddy/listeners/web.caddy"] = str(INFRA / "ingress/web.caddy")
    mounts = ingress.get("volumes", [])
    if (len(mounts) != len(expected_mounts)
            or any(m.get("type") != "bind" or m.get("read_only") is not True
                   or expected_mounts.get(m["target"]) != m.get("source") for m in mounts)):
        raise RuntimeError("The ingress may mount only its reviewed read-only configuration")


def validate_ingress_routes(config, *, include_web=False):
    """Allow only the fixed HTTP upstreams; never TLS, identity rewriting or logs."""
    actual = dict(config)
    apps = actual.pop("apps", {})
    http = apps.get("http", {})
    servers = http.get("servers", {})
    upstreams = {":8080": "api:8080"}
    if include_web:
        upstreams[":3000"] = "web:3000"
    expected_servers = [{
        "listen": [listen],
        "routes": [{"handle": [{"handler": "reverse_proxy", "upstreams": [{"dial": upstream}]}]}],
        "automatic_https": {"disable": True},
    } for listen, upstream in upstreams.items()]
    if (actual != {"admin": {"disabled": True, "config": {"persist": False}},
                   "logging": {"logs": {"default": {"exclude": ["http"]}}}}
            or set(apps) != {"http"} or set(http) != {"servers"}
            or len(servers) != len(expected_servers)
            or any(server not in expected_servers for server in servers.values())
            or len({tuple(server.get("listen", [])) for server in servers.values()}) != len(expected_servers)):
        raise RuntimeError("The ingress must provide only its fixed HTTP routes without identity rewriting, TLS or request logs")


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
    ingress_provenance = json.loads((INFRA / "ingress/provenance.json").read_text())
    report = {"schemaVersion": 2, "status": "passed",
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
        validate_production_topology(actual, ingress_provenance["image"])
        for service in original["services"]:
            before = original["services"][service].copy()
            after = actual["services"][service].copy()
            if service in ("api", "migrate"):
                before.pop("image")
                after.pop("image")
            if before != after:
                raise RuntimeError("The bootstrap overlay changed production runtime configuration")
        report["productionConfigurationPreserved"] = True
        web_config = json.loads(run(base + ["--file", INFRA / "compose.web.yaml",
                                             "config", "--format", "json"], env=fixture_env).stdout)
        validate_production_topology(web_config, ingress_provenance["image"], include_web=True)
        report["optionalWeb"] = {
            "composeTopologyVerified": True,
            "runtimeVerified": False,
            "scope": "configuration only; no Next image, HTTP path or browser scenario is qualified by this gate",
        }
        # Resolve the explicit opt-in overlay without contacting a real relay.
        mail_env = dict(fixture_env)
        mail_env.update({"TROPA_SMTP_HOST": "smtp.fixture.invalid", "TROPA_SMTP_PORT": "465",
                         "TROPA_SMTP_TLS_MODE": "tls", "TROPA_MAIL_FROM": "fixture@example.invalid",
                         "TROPA_SMTP_USERNAME": "", "TROPA_SMTP_PASSWORD": "",
                         "TROPA_ACCOUNT_ACTION_URL": "https://fixture.tropnik.invalid/account/action"})
        mail_config = json.loads(run(base + ["--file", INFRA / "compose.web.yaml", "--file", INFRA / "compose.mail.yaml",
                                              "config", "--format", "json"], env=mail_env).stdout)
        validate_production_topology(mail_config, ingress_provenance["image"], include_web=True, mail_enabled=True)
        report["optionalMailTopologyVerified"] = True
        compose("pull", "ingress", timeout=180)
        ingress_image = json.loads(run(["docker", "image", "inspect", ingress_provenance["image"]]).stdout)[0]
        if (ingress_image["Id"] != ingress_provenance["amd64ConfigDigest"]
                or ingress_image["Os"] != "linux" or ingress_image["Architecture"] != "amd64"
                or ingress_image["Config"].get("Labels", {}).get("org.opencontainers.image.version") != ingress_provenance["version"]):
            raise RuntimeError("The pulled ingress image differs from the reviewed official image")
        report["ingress"] = {"image": ingress_provenance["image"], "imageId": ingress_image["Id"],
                             "provenanceSHA256": hashlib.sha256((INFRA / "ingress/provenance.json").read_bytes()).hexdigest()}
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
            ingress_id, ingress = inspect("ingress")
            if database["Image"] != image_proof["imageId"]:
                raise RuntimeError("Production bootstrap did not use the qualified PostgreSQL/PostGIS image")
            if migration["State"]["Status"] != "exited" or migration["State"]["ExitCode"] != 0:
                raise RuntimeError("The actual migration binary did not finish successfully")
            if api["Image"] != image["Id"] or migration["Image"] != image["Id"]:
                raise RuntimeError("Bootstrap services did not use the built API image")
            if ingress["Image"] != ingress_image["Id"]:
                raise RuntimeError("The running ingress does not use the qualified official image")
            bindings = ingress["HostConfig"]["PortBindings"].get("8080/tcp", [])
            if len(bindings) != 1 or bindings[0]["HostIp"] != "127.0.0.1":
                raise RuntimeError("The configured ingress API port is not loopback-only")
            if set(ingress["HostConfig"]["PortBindings"]) != {"8080/tcp"}:
                raise RuntimeError("The base ingress publishes an unexpected port")
            for service, state in (("database", database), ("API", api), ("migration", migration)):
                if state["HostConfig"]["PortBindings"] or any((state["NetworkSettings"].get("Ports") or {}).values()):
                    raise RuntimeError(f"The production {service} unexpectedly publishes a direct host port")
            origin = "http://127.0.0.1:" + bindings[0]["HostPort"]
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            deadline = time.monotonic() + 60

            def startup_diagnostic(state):
                # Inspect only this synthetic process. Export known constant
                # startup reasons, never raw logs or environment values.
                logs = run(["docker", "logs", "--tail", "20", api_id], check=False)
                text = logs.stdout + logs.stderr
                source = (INFRA.parent / "backend/cmd/tropa-api/main.go").read_text()
                constants = re.findall(r'return errors.New\("([^"\n]*)"\)', source)
                return {
                    "status": state["State"]["Status"],
                    "running": state["State"]["Running"],
                    "restarting": state["State"]["Restarting"],
                    "exitCode": state["State"]["ExitCode"],
                    "restartCount": state["RestartCount"],
                    "ingressConfiguredBindings": ingress["HostConfig"]["PortBindings"].get("8080/tcp"),
                    "ingressActiveBindings": (ingress["NetworkSettings"].get("Ports") or {}).get("8080/tcp"),
                    "ingressStatus": ingress["State"]["Status"],
                    "knownStartupReasons": sorted({reason for reason in constants if reason in text}),
                    "startupFailureLogged": "API could not start" in text,
                }

            while True:
                try:
                    with opener.open(origin + "/api/v1/health/ready", timeout=2) as response:
                        ready = health_response_matches(response, "ready")
                except (OSError, ValueError, urllib.error.HTTPError):
                    ready = False
                api_id, api = inspect("api")
                ingress_id, ingress = inspect("ingress")
                active_bindings = (ingress["NetworkSettings"].get("Ports") or {}).get("8080/tcp", [])
                if active_bindings and active_bindings != bindings:
                    raise RuntimeError("The active ingress port differs from its loopback configuration")
                if any(s["State"]["Restarting"] or (not s["State"]["Running"] and s["State"]["ExitCode"] != 0)
                       for s in (api, ingress)):
                    print(json.dumps({"bootstrapFailure": startup_diagnostic(api)}), flush=True)
                    raise RuntimeError("The production API or ingress exited during clean bootstrap")
                if ready and all(s["State"].get("Health", {}).get("Status") == "healthy" for s in (api, ingress)):
                    if active_bindings != bindings:
                        raise RuntimeError("The ready ingress does not have its required active loopback binding")
                    break
                if time.monotonic() >= deadline:
                    print(json.dumps({"bootstrapFailure": startup_diagnostic(api)}), flush=True)
                    raise RuntimeError("The host-to-ingress-to-API path did not become HTTP/Docker ready")
                time.sleep(1)
            with opener.open(origin + "/api/v1/health/live", timeout=2) as response:
                if not health_response_matches(response, "ok"):
                    raise RuntimeError("The production liveness endpoint failed")
            run(["docker", "exec", api_id, "/tropa-health"])
            proc_reads = {}

            def read_fixture_proc(pid, service, leaf):
                if leaf not in ("status", "mountinfo"):
                    raise RuntimeError("Unexpected fixture process inspection")
                path = Path("/proc") / str(pid) / leaf
                try:
                    contents = path.read_text()
                    proc_reads[service + "/" + leaf] = "direct"
                except PermissionError:
                    # The runner UID differs from the deliberately unprivileged
                    # service UID. Elevate only this read of its validated paths.
                    contents = run(["sudo", "-n", "cat", path]).stdout
                    proc_reads[service + "/" + leaf] = "sudo-read-only"
                return contents

            for service, state in (("api", api), ("ingress", ingress)):
                host = state["HostConfig"]
                if (state["Config"]["User"] != "65532:65532" or not host["ReadonlyRootfs"]
                        or set(host["CapDrop"] or []) != {"ALL"}
                        or "no-new-privileges:true" not in host["SecurityOpt"]):
                    raise RuntimeError(f"The {service} runtime hardening differs from production configuration")
                pid = state["State"]["Pid"]
                if type(pid) is not int or pid <= 1 or not state["State"]["Running"]:
                    raise RuntimeError(f"The fixture {service} has no valid running host process")
                kernel = dict(line.split(":", 1) for line in read_fixture_proc(pid, service, "status").splitlines() if ":" in line)
                if (set(kernel["Uid"].split()) != {"65532"} or set(kernel["Gid"].split()) != {"65532"}
                        or int(kernel["CapEff"].strip(), 16) != 0 or kernel["NoNewPrivs"].strip() != "1"):
                    raise RuntimeError(f"The running {service} process does not enforce its unprivileged policy")
                root_mounts = [line.split() for line in read_fixture_proc(pid, service, "mountinfo").splitlines()
                               if line.split()[4] == "/"]
                if len(root_mounts) != 1 or "ro" not in root_mounts[0][5].split(","):
                    raise RuntimeError(f"The running {service} root filesystem is not read-only")
                _, after_kernel_check = inspect(service)
                if not after_kernel_check["State"]["Running"] or after_kernel_check["State"]["Pid"] != pid:
                    raise RuntimeError(f"The {service} process changed during kernel policy inspection")
            report["kernelProcReadMethods"] = proc_reads
            for name, expected_internal in (("backend", True), ("application", True), ("frontend", False)):
                network_name = actual["networks"][name]["name"]
                network = json.loads(run(["docker", "network", "inspect", network_name]).stdout)[0]
                if (network["Internal"] is not expected_internal
                        or network["Labels"].get("com.docker.compose.project") != project):
                    raise RuntimeError("A production fixture network does not match its isolation contract")
            for service, state in (("api", api), ("ingress", ingress), ("db", database)):
                expected_network_names = {actual["networks"][name]["name"] for name in actual["services"][service]["networks"]}
                if set(state["NetworkSettings"]["Networks"]) != expected_network_names:
                    raise RuntimeError(f"The actual {service} network attachments differ from the reviewed topology")
            ingress_version = run(["docker", "exec", ingress_id, "caddy", "version"]).stdout.strip()
            if ingress_version.split()[0] != ingress_provenance["version"]:
                raise RuntimeError("The running ingress binary version differs from its reviewed provenance")
            ingress_config = json.loads(run(["docker", "exec", ingress_id, "caddy", "adapt", "--config",
                                            "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]).stdout)
            validate_ingress_routes(ingress_config)
            run(["docker", "exec", ingress_id, "caddy", "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"])
            report["ingress"]["version"] = ingress_version
            report["ingress"]["configurationSHA256"] = {
                path: hashlib.sha256((INFRA / "ingress" / path).read_bytes()).hexdigest()
                for path in ("Caddyfile", "api.caddy")
            }
            report["ingress"]["configurationValidated"] = True
            report["ingress"]["fixedHTTPRoutesVerified"] = True
            report["ingress"]["kernelPolicyVerified"] = True
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
                                 "internalDatabaseNetwork": True, "internalApplicationNetwork": True,
                                 "ingressLoopbackOnly": True, "apiPortUnpublished": True,
                                 "databasePortUnpublished": True, "ingressExcludedFromDatabaseNetwork": True,
                                 "apiExternalNetworkAbsent": True, "migrationExitCode": 0,
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
