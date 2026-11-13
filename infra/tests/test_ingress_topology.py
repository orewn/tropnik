"""Resolve the real Compose files and guard the production network boundary."""

import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest


INFRA = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("verify_backend_bootstrap", INFRA / "verify-backend-bootstrap.py")
BOOTSTRAP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BOOTSTRAP)


class ProductionIngressTopologyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get("TROPNIK_COMPOSE"):
            compose = [os.environ["TROPNIK_COMPOSE"]]
        elif shutil.which("docker"):
            compose = ["docker", "compose"]
        elif shutil.which("docker-compose"):
            compose = ["docker-compose"]
        else:
            raise RuntimeError("Compose is required to resolve the actual deployment files; set TROPNIK_COMPOSE for a standalone binary")
        # Do not use credentials, .env or a Docker daemon. These values are only
        # interpolation fixtures; all mail destinations are reserved examples.
        env = dict(os.environ)
        env.update({
            "POSTGRES_PASSWORD": "fixture-owner-only",
            "TROPA_APP_PASSWORD": "fixture-app-only",
            "PUBLIC_ORIGIN": "https://fixture.tropnik.invalid",
            "TROPA_AUTH_RATE_KEY": "a" * 64,
            "TROPA_SAFETY_DATA_KEY": "b" * 64,
            "TROPA_ACCOUNT_MAIL_KEY": "c" * 64,
            "TRUSTED_PROXY_CIDRS": "",
            "TROPA_PROXY_TOKEN": "",
            "TROPA_PUBLIC_INDEXING": "false",
            "TROPA_SMTP_HOST": "smtp.fixture.invalid",
            "TROPA_SMTP_PORT": "465",
            "TROPA_SMTP_TLS_MODE": "tls",
            "TROPA_SMTP_USERNAME": "",
            "TROPA_SMTP_PASSWORD": "",
            "TROPA_MAIL_FROM": "fixture@example.invalid",
            "TROPA_ACCOUNT_ACTION_URL": "https://fixture.tropnik.invalid/account/action",
        })
        cls.image = json.loads((INFRA / "ingress/provenance.json").read_text())["image"]
        cls.configs = {}
        for web, mail in ((False, False), (True, False), (False, True), (True, True)):
            argv = compose + ["--project-name", "tropa-topology-test", "--env-file", os.devnull,
                              "--file", str(INFRA / "compose.yaml")]
            if web:
                argv += ["--file", str(INFRA / "compose.web.yaml")]
            if mail:
                argv += ["--file", str(INFRA / "compose.mail.yaml")]
            result = subprocess.run(argv + ["config", "--format", "json"], cwd=INFRA.parent, env=env,
                                    check=True, capture_output=True, text=True, timeout=30)
            cls.configs[web, mail] = json.loads(result.stdout)

    def validate(self, config, *, web=False, mail=False):
        BOOTSTRAP.validate_production_topology(config, self.image, include_web=web, mail_enabled=mail)

    def test_all_four_real_compose_combinations_match_the_boundary(self):
        for (web, mail), config in self.configs.items():
            with self.subTest(web=web, mail=mail):
                self.validate(config, web=web, mail=mail)

    def test_api_database_and_web_cannot_publish_direct_ports(self):
        for service in ("api", "db", "web"):
            with self.subTest(service=service):
                config = copy.deepcopy(self.configs[True, False])
                config["services"][service]["ports"] = [{"target": 8080, "published": "8080", "host_ip": "127.0.0.1"}]
                with self.assertRaisesRegex(RuntimeError, "direct host port"):
                    self.validate(config, web=True)

    def test_ingress_and_web_cannot_join_the_database_network(self):
        for service in ("ingress", "web"):
            with self.subTest(service=service):
                config = copy.deepcopy(self.configs[True, False])
                config["services"][service]["networks"]["backend"] = None
                with self.assertRaisesRegex(RuntimeError, "network attachment"):
                    self.validate(config, web=True)

    def test_api_cannot_gain_default_egress(self):
        config = copy.deepcopy(self.configs[False, False])
        config["services"]["api"]["networks"]["frontend"] = None
        with self.assertRaisesRegex(RuntimeError, "network attachment"):
            self.validate(config)
        config = copy.deepcopy(self.configs[False, False])
        config["networks"]["application"]["internal"] = False
        with self.assertRaisesRegex(RuntimeError, "isolation policy"):
            self.validate(config)

    def test_ingress_cannot_publish_to_the_public_interface(self):
        config = copy.deepcopy(self.configs[False, False])
        config["services"]["ingress"]["ports"][0]["host_ip"] = "0.0.0.0"
        with self.assertRaisesRegex(RuntimeError, "loopback HTTP ports"):
            self.validate(config)

    def test_ingress_image_and_runtime_hardening_cannot_drift(self):
        for key, value, error in (("image", "caddy:latest", "reviewed image"),
                                  ("user", "0:0", "runtime hardening"),
                                  ("read_only", False, "runtime hardening"),
                                  ("cap_drop", [], "runtime hardening")):
            with self.subTest(setting=key):
                config = copy.deepcopy(self.configs[False, False])
                config["services"]["ingress"][key] = value
                with self.assertRaisesRegex(RuntimeError, error):
                    self.validate(config)

    def test_web_overlay_keeps_api_readiness_dependency(self):
        config = copy.deepcopy(self.configs[True, False])
        del config["services"]["ingress"]["depends_on"]["api"]
        with self.assertRaisesRegex(RuntimeError, "upstreams"):
            self.validate(config, web=True)

    def test_ingress_configuration_mounts_cannot_become_writable(self):
        config = copy.deepcopy(self.configs[False, False])
        config["services"]["ingress"]["volumes"][0]["read_only"] = False
        with self.assertRaisesRegex(RuntimeError, "read-only configuration"):
            self.validate(config)


if __name__ == "__main__":
    unittest.main()
