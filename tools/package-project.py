#!/usr/bin/env python3
"""Create a reviewed, allowlisted source snapshot. Never uploads or signs files.

Only Python's standard library is used. APKs are independent release artifacts;
runtime map PBF/PNG/font/license assets are source inputs and remain included.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import zipfile


TREES = (
    "backend", "contracts", "docs", "infra", "tools", ".github/workflows",
    "android/app/src", "android/app/schemas", "android/gradle/wrapper",
    "web/app", "web/components", "web/lib", "web/hooks", "web/public",
    "web/scripts", "web/worker", "web/vendor", "web/db", "web/drizzle",
    "web/examples", "web/tests", "web/verification", "web/docs", "web/pages-preview/src",
    "data/catalog", "data/boundaries", "data/pilot-map", "data/terrain-pilot/runtime", "data/overview-relief",
)
EXACT = {
    "README.md", ".gitignore", "LICENSE", "LICENSE.md", "NOTICE", "NOTICE.md",
    "android/README.md", "android/BUILD-VERIFICATION.md", "android/.gitignore",
    "android/build.gradle.kts", "android/settings.gradle.kts",
    "android/gradle.properties", "android/gradlew", "android/gradlew.bat",
    "android/app/build.gradle.kts", "android/app/proguard-rules.pro",
    "web/.dockerignore", "web/.gitignore", "web/.npmrc",
    "web/.openai/hosting.json", "web/Dockerfile", "web/README.md",
    "web/package.json", "web/pnpm-lock.yaml", "web/pnpm-workspace.yaml",
    "web/components.json", "web/next-env.d.ts", "web/next.config.ts",
    "web/tsconfig.json", "web/cloudflare-env.d.ts", "web/drizzle.config.ts",
    "web/eslint.config.mjs", "web/postcss.config.mjs", "web/vite.config.ts",
    "web/pages-preview/tsconfig.json",
    "data/geometry-provenance.json", "data/route-11566519.geojson",
    "data/route-catalog.json", "data/terrain-pilot/landscape.html",
    "data/terrain-pilot/terrain-grid.json",
}
SKIP_DIRS = {
    "node_modules", ".next", "dist", "build", "_deps", ".git", ".gradle",
    ".kotlin", ".idea", ".vscode", ".venv", "venv", "__pycache__",
    ".cache", "cache", ".npm", ".pnpm-store", ".turbo", ".vercel",
    ".wrangler", ".vinext", ".sites-runtime", ".rsync-tmp", "coverage",
    "playwright-report", "test-results", "captures", "outputs", "output",
    "toolchains", "android-sdk", "sdk", ".ssh", ".aws", ".azure",
}
SKIP_NAMES = {
    "local.properties", "keystore.properties", "key.properties",
    "credentials", "credentials.json", "service-account.json",
    "id_rsa", "id_ed25519", ".DS_Store", "Thumbs.db",
}
SKIP_SUFFIXES = {
    ".apk", ".aab", ".apks", ".jks", ".keystore", ".p12", ".pfx",
    ".pem", ".key", ".der", ".mobileprovision", ".dex", ".class",
    ".o", ".so", ".dylib", ".dll", ".exe", ".pyc", ".pyo",
    ".tsbuildinfo", ".log", ".tmp", ".bak", ".sqlite", ".sqlite3",
    ".db", ".zip", ".tar", ".gz", ".xz", ".7z",
}
REQUIRED = (
    "README.md", "docs/architecture.md", "docs/acceptance.md",
    "web/package.json", "web/pnpm-lock.yaml", "web/app/page.tsx",
    "web/public/downloads/android-manifest.json",
    "backend/go.mod", "backend/migrations/002_moderation.sql",
    "contracts/openapi.yaml", "contracts/api.ts",
    "android/gradlew", "android/gradle/wrapper/gradle-wrapper.jar",
    "android/app/src/main/AndroidManifest.xml",
    "android/app/src/main/assets/licenses/MapLibre-Native-LICENSE.md",
    "data/catalog/DATA_LICENSE.txt", "data/pilot-map/manifest.json",
    "data/boundaries/ATTRIBUTION.txt", "data/boundaries/manifest.json",
    "data/boundaries/raw/geoBoundaries-RUS-ADM1.geojson",
    "data/boundaries/raw/geoBoundaries-UKR-ADM1.geojson",
    "web/public/data/russia-display-area.geojson",
    "web/public/data/russia-canonical-mask.geojson",
    "web/public/data/russia-boundaries-provenance.json",
    "web/public/maps/russia-viewport.js",
    "web/public/terrain/terrain-renderer.js",
    "data/terrain-pilot/runtime/ATTRIBUTION.txt",
    "data/terrain-pilot/runtime/sources/Copernicus-GLO30-LICENSE.pdf",
    "web/public/offline-map/licenses/Noto-Sans-OFL-1.1.txt",
    "web/public/maps/LEAFLET-LICENSE.txt", "web/public/maps/PROTOMAPS-LEAFLET-LICENSE.txt",
    "web/public/fonts/MANROPE-LICENSE.txt",
    ".github/workflows/android.yml",
)
# Only high-confidence token/key forms; diagnostics report path + rule, not data.
# This bounded check is not a replacement for a dedicated release secret scan.
SECRET_PATTERNS = {
    "private_key": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    "github_token": re.compile(rb"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b"),
    "aws_access_key": re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "openai_token": re.compile(rb"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}\b"),
    "npm_auth_token": re.compile(rb"(?im)^\s*[^\n]*:_authToken\s*=\s*(?!\$\{|$)[A-Za-z0-9_./+-]{12,}\s*$"),
}


class PackagingError(RuntimeError):
    pass


def under(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(prefix + "/")


def allowed(path: str) -> bool:
    return path in EXACT or any(under(path, p) for p in TREES)


def can_descend(path: str) -> bool:
    return any(under(path, p) or under(p, path) for p in TREES) or any(
        under(p, path) for p in EXACT
    )


def excluded(path: str, profile: str) -> str | None:
    p = PurePosixPath(path)
    if any(part in SKIP_DIRS for part in p.parts):
        return "generated_or_local_directory"
    if under(path, "web/public/downloads") and path not in {
        "web/public/downloads", "web/public/downloads/android-manifest.json",
    }:
        return "separate_apk_delivery"
    if path in {
        "data/boundaries/selected-area-source.wkb",
        "data/boundaries/selected-area-source-cache.json",
    }:
        return "rebuildable_boundary_processing_cache"
    if under(path, "tools/github-publish/generated") or under(path, "tools/db-compat/.work"):
        return "rebuildable_verification_transport"
    if p.name in SKIP_NAMES or path == "web/package-lock.json":
        return "local_config_or_stale_lock"
    if (p.name.startswith(".env") and not p.name.endswith(".example")) or p.name.startswith(".dev.vars"):
        return "local_environment"
    if p.suffix.lower() in SKIP_SUFFIXES:
        return "build_archive_or_sensitive_file_type"
    if p.suffix.lower() == ".jar" and path != "android/gradle/wrapper/gradle-wrapper.jar":
        return "binary_dependency"
    if profile == "github" and (
        path == "data/catalog/raw-trails-krym.geojson"
        or (under(path, "data/catalog/raw/geofabrik") and path.endswith(".osm.pbf"))
    ):
        return "bulk_audit_data_in_full_zip_only"
    return None


def select_files(root: Path, profile: str, require_project: bool = True) -> tuple[list[Path], dict[str, int]]:
    selected: list[Path] = []
    skipped: Counter[str] = Counter()
    for current, dirs, names in os.walk(root, followlinks=False):
        current_path = Path(current)
        for name in sorted(dirs[:]):
            candidate = current_path / name
            rel = candidate.relative_to(root).as_posix()
            reason = excluded(rel, profile)
            if reason or not can_descend(rel):
                dirs.remove(name)
                skipped[reason or "outside_allowlist"] += 1
            elif candidate.is_symlink():
                raise PackagingError(f"Refusing selected symlink directory: {rel}")
        for name in sorted(names):
            candidate = current_path / name
            rel = candidate.relative_to(root).as_posix()
            reason = excluded(rel, profile)
            if reason or not allowed(rel):
                skipped[reason or "outside_allowlist"] += 1
                continue
            if candidate.is_symlink() or not candidate.is_file():
                raise PackagingError(f"Refusing non-regular selected file: {rel}")
            if candidate.stat().st_size >= 100_000_000:
                raise PackagingError(f"Selected file exceeds source-review size cap: {rel}")
            selected.append(candidate)
    selected.sort(key=lambda p: p.relative_to(root).as_posix())
    if require_project:
        present = {p.relative_to(root).as_posix() for p in selected}
        missing = [p for p in REQUIRED if p not in present]
        if missing:
            raise PackagingError("Required sources/license notices missing: " + ", ".join(missing))
    return selected, dict(sorted(skipped.items()))


def scan_and_record(root: Path, files: list[Path]) -> list[dict[str, object]]:
    records = []
    findings: list[str] = []
    for path in files:
        rel = path.relative_to(root).as_posix()
        data = path.read_bytes()
        for rule, pattern in SECRET_PATTERNS.items():
            if pattern.search(data):
                findings.append(f"{rel}: {rule}")
        records.append({"path": rel, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    if findings:
        raise PackagingError("Potential credentials; inspect locally before packaging (values withheld):\n" + "\n".join(findings))
    return records


def verify_zip(path: Path, records: list[dict[str, object]]) -> None:
    expected = {"tropnik/" + str(r["path"]): r for r in records}
    expected_names = set(expected) | {"tropnik/SOURCE-INVENTORY.json"}
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or set(names) != expected_names:
            raise PackagingError("ZIP file inventory differs from the reviewed source snapshot")
        for name, record in expected.items():
            data = archive.read(name)
            if len(data) != record["bytes"] or hashlib.sha256(data).hexdigest() != record["sha256"]:
                raise PackagingError(f"ZIP content verification failed: {record['path']}")


def make_snapshot(root: Path, output: Path, records: list[dict[str, object]], profile: str,
                  skipped: dict[str, int], make_zip: bool = True) -> dict[str, object]:
    if output == root or root in output.parents:
        raise PackagingError("Output must be outside the source tree")
    if output.exists():
        raise PackagingError("Output already exists; choose a new destination, no files were overwritten")
    output.mkdir(parents=True)
    stage = output / "source" / "tropnik"
    stage.mkdir(parents=True)
    inventory = {
        "schemaVersion": 1,
        "project": "Тропник",
        "profile": profile,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "fileCount": len(records),
        "totalBytes": sum(int(r["bytes"]) for r in records),
        "excludedEntryCounts": skipped,
        "apkIncluded": False,
        "localToolchainsIncluded": False,
        "scan": "High-confidence key/token patterns and path policy; not a full security certification",
        "files": records,
    }
    for record in records:
        rel = str(record["path"])
        source = root / rel
        target = stage / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        if hashlib.sha256(target.read_bytes()).hexdigest() != record["sha256"]:
            raise PackagingError(f"Source changed during snapshot; rebuild after edits stop: {rel}")
        target.chmod(0o755 if source.stat().st_mode & stat.S_IXUSR else 0o644)
    encoded = (json.dumps(inventory, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    (stage / "SOURCE-INVENTORY.json").write_bytes(encoded)
    (output / "source-inventory.json").write_bytes(encoded)
    result: dict[str, object] = {
        "profile": profile, "staging": str(stage), "inventory": str(output / "source-inventory.json"),
        "sourceFiles": len(records), "sourceBytes": inventory["totalBytes"],
    }
    if make_zip:
        archive_path = output / "tropnik-source.zip"
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for rel in sorted([str(r["path"]) for r in records] + ["SOURCE-INVENTORY.json"]):
                source = stage / rel
                info = zipfile.ZipInfo("tropnik/" + rel, date_time=(2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = ((stat.S_IFREG | stat.S_IMODE(source.stat().st_mode)) << 16)
                archive.writestr(info, source.read_bytes(), compresslevel=6)
        verify_zip(archive_path, records)
        result.update(zip=str(archive_path), zipBytes=archive_path.stat().st_size,
                      zipSha256=hashlib.sha256(archive_path.read_bytes()).hexdigest(), zipVerified=True)
    (output / "package-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path, help="New output directory outside source; never overwritten")
    parser.add_argument("--profile", choices=("source", "github"), default="source")
    parser.add_argument("--dry-run", action="store_true", help="Audit the selected files without writing a snapshot")
    parser.add_argument("--no-zip", action="store_true", help="Produce reviewed staging/inventory only")
    args = parser.parse_args()
    try:
        root = args.source.resolve(strict=True)
        files, skipped = select_files(root, args.profile)
        records = scan_and_record(root, files)
        if args.dry_run:
            print(json.dumps({"profile": args.profile, "files": len(records),
                              "bytes": sum(int(r["bytes"]) for r in records),
                              "excludedEntryCounts": skipped, "secretPatternFindings": 0}, indent=2))
            return 0
        if args.output is None:
            parser.error("--output is required unless --dry-run is used")
        result = make_snapshot(root, args.output.resolve(), records, args.profile, skipped, not args.no_zip)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (PackagingError, OSError, zipfile.BadZipFile) as error:
        print(f"Packaging stopped: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
