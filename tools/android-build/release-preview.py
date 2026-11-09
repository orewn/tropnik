#!/usr/bin/env python3
"""Prepare and publish one explicitly requested, verified Android prerelease.

Publication uses only the workflow's job-scoped GITHUB_TOKEN. No overwrite,
release deletion, private signing key or production signing is implemented.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import zipfile

from preview_artifacts import (ARM64, RECEIPT, REPORT_NAMES, TEST_APK, UNIVERSAL,
                               fingerprint, read_json, require, source_version, verify_receipt)

REQUEST = "tools/android-build/release-request.json"
REPOSITORY = "orewn/tropnik"


def read_request(root: Path):
    request = read_json(root / REQUEST)
    require(set(request) == {"schemaVersion", "requestId", "version", "versionCode", "notesFile"} and
            request["schemaVersion"] == 1 and
            isinstance(request["requestId"], str) and re.fullmatch(r"[a-z][a-z0-9-]{7,95}", request["requestId"]) and
            isinstance(request["version"], str) and re.fullmatch(r"\d+\.\d+\.\d+-preview", request["version"]) and
            type(request["versionCode"]) is int and request["versionCode"] > 0,
            "Invalid explicit preview release request")
    expected_notes = f"tools/android-build/release-notes/{request['version']}.md"
    require(request["notesFile"] == expected_notes, "Release notes must use the versioned notes path")
    notes = root / expected_notes
    require(notes.is_file() and not notes.is_symlink() and 0 < notes.stat().st_size < 30_000,
            "Missing or oversized release notes")
    return request


def is_requested(root: Path, event: str, ref: str, before: str, manual: bool):
    if ref != "refs/heads/main":
        return False
    if event == "workflow_dispatch":
        return manual
    if event != "push":
        return False
    require(re.fullmatch(r"[a-f0-9]{40}", before or ""), "Push event has no valid before SHA")
    if before == "0" * 40:
        # The initial main creation is itself an explicit addition of the request.
        changed = subprocess.check_output(["git", "ls-tree", "--name-only", "HEAD", "--", REQUEST], cwd=root, text=True)
    else:
        changed = subprocess.check_output(["git", "diff", "--name-only", before, "HEAD", "--", REQUEST], cwd=root, text=True)
    return REQUEST in changed.splitlines()


def gate(root: Path):
    requested = is_requested(root, os.environ.get("GITHUB_EVENT_NAME", ""), os.environ.get("GITHUB_REF", ""),
                             os.environ.get("TROPNIK_BEFORE_SHA", ""), os.environ.get("TROPNIK_PUBLISH_PREVIEW") == "true")
    version = ""
    if requested:
        request = read_request(root)
        require((request["version"], request["versionCode"]) == source_version(root),
                "Release request version/code differs from Android source")
        version = request["version"]
    output = f"release_requested={'true' if requested else 'false'}\nrelease_version={version}\n"
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
            stream.write(output)
    print(output, end="")


def validate_device(device, build, directory):
    require(device.get("schemaVersion") == 2 and device.get("status") == "passed" and
            all(device.get(key) is True for key in ("deviceExecutionVerified", "releasePayloadDeviceVerified", "installedArtifactBytesVerified")) and
            device.get("testedArtifact") == UNIVERSAL and device.get("testedArchitecture") == "x86_64",
            "No exact-artifact device success receipt")
    require(device.get("sourceCommit") == build["sourceCommit"] and device.get("workflowRunId") == build["workflowRunId"] and
            device.get("buildReceiptSha256") == fingerprint(directory / RECEIPT)["sha256"],
            "Device proof belongs to another build")
    require(device.get("testedApks") == {name: build["files"][name] for name in (UNIVERSAL, TEST_APK)},
            "Device proof is not for these APK bytes")
    # Re-evaluate the recorded cases, rather than accepting only a boolean flag.
    import importlib.util
    spec = importlib.util.spec_from_file_location("instrumentation_check", Path(__file__).with_name("check-instrumentation.py"))
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    cases = device.get("cases", [])
    require(device.get("tests") == len(checker.EXPECTED) and len(cases) == len(checker.EXPECTED) and
            {(case.get("className"), case.get("name")) for case in cases} == {(checker.CLASS_NAME, name) for name in checker.EXPECTED} and
            all(case.get("statusCode") == 0 and all(case.get(k) is False for k in ("failed", "error", "skipped")) for case in cases) and
            all(device.get(k) == 0 for k in ("failures", "errors", "skipped", "processExitCode")) and
            device.get("instrumentationResultCodes") == [-1] and not device.get("parseErrors") and not device.get("missingTests"),
            "Incomplete, skipped or failed instrumentation cases")
    require(device.get("physicalDeviceVerified") is False and device.get("arm64DeviceExecutionVerified") is False,
            "Emulator proof must not claim ARM64 or physical-device execution")


def prepare(root: Path, directory: Path, device_directory: Path, output: Path):
    request = read_request(root)
    build = verify_receipt(directory, root)
    require((request["version"], request["versionCode"]) == (build["version"], build["versionCode"]),
            "Release request is not for this APK version")
    require(str(build.get("workflowRunId", "")).isdigit(), "Release artifacts must come from an identified CI run")
    device = read_json(device_directory / "device-result.json")
    validate_device(device, build, directory)
    # Reparse the retained raw result before promotion, and compare installed proof.
    import importlib.util
    spec = importlib.util.spec_from_file_location("release_device_check", Path(__file__).with_name("check-instrumentation.py"))
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    raw = device_directory / "raw-instrumentation.log"
    require(raw.is_file() and raw.stat().st_size < 20_000_000, "Missing actual instrumentation log")
    parsed = checker.inspect_raw(raw.read_text(errors="replace"), device["processExitCode"])
    require(parsed["deviceExecutionVerified"] and parsed["cases"] == device["cases"], "Raw device results differ from receipt")
    checker.bind_artifact(parsed, directory, root, device_directory / "installed-apks.json")
    require(not output.exists() or not any(output.iterdir()), "Release output must be empty")
    output.mkdir(parents=True, exist_ok=True)
    for name in (ARM64, UNIVERSAL):
        shutil.copyfile(directory / name, output / name)
    verification = read_json(directory / "tropnik-arm64-preview.verification.json")
    metadata = {"version": build["version"], "versionCode": build["versionCode"], "architecture": "arm64-v8a",
                "releaseRequestId": request["requestId"],
                "minSdk": 26, "targetSdk": 36, **build["files"][ARM64],
                "signature": "development / debug", "compatibleWithPreviousPreview": False,
                "signingCertificateSha256": build["signingCertificateSha256"],
                "sourceCommit": build["sourceCommit"], "workflowRunId": int(build["workflowRunId"]),
                "jvmTestsPassed": build["jvmTestsPassed"], "deviceTestCount": device["tests"],
                "deviceTestEnvironment": device["environment"], "physicalDeviceVerified": False,
                "deviceExecutionVerified": False, "releasePayloadDeviceVerified": False,
                "codeDeviceExecutionVerified": True, "universalReleasePayloadDeviceVerified": True,
                "testedUniversalSha256": build["files"][UNIVERSAL]["sha256"],
                "plannerMode": "browser", "plannerUrl": "https://orewn.github.io/tropnik/planner/",
                "fullRussiaDetailedOffline": False, "losslessPayloadVerified": True,
                "onlineDetailedMapAvailable": True,
                "russiaCoverageProvenanceSha256": verification["russiaDisplayProvenanceSha256"],
                "sceneGridDimensions": verification["landscapeGridDimensions"]}
    for name in ("russiaOverviewTileCount", "russiaOverviewManifestSha256", "catalogReferenceRouteCount",
                 "catalogRegionCount", "catalogLearningRouteCount", "catalogReferenceOnlyRouteCount",
                 "catalogSha256", "catalogManifestSha256"):
        metadata[name] = verification[name]
    metadata["localRouteGeometryCount"] = verification["catalogGeometryFilesVerified"]
    (output / "android-manifest.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    # Stable ZIP timestamps make a repeated publish job compare exact content.
    with zipfile.ZipFile(output / "verification-reports.zip", "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        reports = [(directory / name, "build/" + name) for name in (RECEIPT,) + REPORT_NAMES]
        reports += [(device_directory / name, "device/" + name) for name in (
            "device-result.json", "installed-apks.json", "raw-instrumentation.log", "TEST-LocalExperienceTest.xml", "tested-apks.sha256")]
        for path, name in sorted(reports, key=lambda item: item[1]):
            require(path.is_file() and not path.is_symlink() and path.stat().st_size < 20_000_000, "Missing/invalid verification report")
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
    source_name = f"tropnik-{build['version']}-source.tar.gz"
    with (output / source_name).open("wb") as stream:
        subprocess.run(["git", "archive", "--format=tar.gz", f"--prefix=tropnik-{build['version']}/", build["sourceCommit"]],
                       cwd=root, stdout=stream, check=True)
    asset_names = [ARM64, UNIVERSAL, "android-manifest.json", "verification-reports.zip", source_name]
    checksums = "".join(f"{fingerprint(output / name)['sha256']}  {name}\n" for name in asset_names)
    (output / "checksums.sha256").write_text(checksums)
    asset_names.append("checksums.sha256")
    run_url = f"https://github.com/{REPOSITORY}/actions/runs/{build['workflowRunId']}"
    body = (root / request["notesFile"]).read_text().rstrip() + (
        f"\n\n## Проверка точной поставки\n\n"
        f"- JVM: {build['jvmTestsPassed']} тестов, без ошибок и пропусков.\n"
        f"- API 35 / x86_64: {device['tests']} из {device['tests']} сценариев прошли **на этом universal APK**, "
        "скачанном из build artifact; SHA установленного base.apk совпал. Повторной сборки в device job нет.\n"
        "- ARM64: подпись, содержимое, выравнивание и SHA проверены; выполнение ARM64 на устройстве не заявляется.\n"
        f"- Источник: `{build['sourceCommit']}`. [CI и отчёты]({run_url}).\n\n"
        "| APK | Размер, байт | SHA-256 |\n| --- | ---: | --- |\n" +
        "".join(f"| `{name}` | {build['files'][name]['bytes']} | `{build['files'][name]['sha256']}` |\n" for name in (ARM64, UNIVERSAL)) +
        "\nАрхив исходников соответствует указанному commit; `verification-reports.zip` содержит подписи, проверки пакетов, "
        "JVM и фактические результаты устройства. `checksums.sha256` связывает файлы этой поставки.\n")
    (output / "release-body.md").write_text(body)
    publication = {"schemaVersion": 1, "requestId": request["requestId"], "sourceCommit": build["sourceCommit"], "workflowRunId": build["workflowRunId"],
                   "tag": "v" + build["version"], "version": build["version"],
                   "name": "Тропник " + build["version"] + " — Android и веб-конструктор",
                   "bodySha256": fingerprint(output / "release-body.md")["sha256"],
                   "assets": [{"name": name, **fingerprint(output / name)} for name in asset_names]}
    (output / "release-upload.json").write_text(json.dumps(publication, ensure_ascii=False, indent=2) + "\n")
    return publication


class GitHub:
    def __init__(self, token):
        self.token = token

    def request(self, method, path, data=None, content_type="application/json", missing_ok=False):
        host = "https://uploads.github.com" if path.startswith("/repos/") and "/assets?" in path else "https://api.github.com"
        # JSON release assets are already bytes; only API payload objects encode.
        body = json.dumps(data).encode() if data is not None and not isinstance(data, (bytes, bytearray)) else data
        request = urllib.request.Request(host + path, data=body, method=method,
            headers={"Authorization": "Bearer " + self.token, "Accept": "application/vnd.github+json",
                     "X-GitHub-Api-Version": "2022-11-28", "Content-Type": content_type,
                     "User-Agent": "tropnik-verified-preview-release"})
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if missing_ok and error.code == 404:
                return None
            # Do not print request headers or any secret-bearing environment.
            raise RuntimeError(f"GitHub {method} failed: HTTP {error.code} ({path.split('?')[0]})") from None


def verify_remote_assets(release, publication, *, allow_partial=False):
    actual = {asset["name"]: asset for asset in release.get("assets", [])}
    expected = {asset["name"]: asset for asset in publication["assets"]}
    require(len(release.get("assets", [])) == len(actual) and
            (actual.keys() <= expected.keys() if allow_partial else actual.keys() == expected.keys()),
            "Existing release assets differ")
    for name, remote in actual.items():
        asset = expected[name]
        require(remote.get("state") == "uploaded" and remote.get("size") == asset["bytes"] and
                remote.get("digest") == "sha256:" + asset["sha256"], f"Remote asset differs: {name}")
    return set(actual)


def publish(output: Path, client):
    publication = read_json(output / "release-upload.json")
    require(os.environ.get("GITHUB_REPOSITORY") == REPOSITORY and os.environ.get("GITHUB_REF") == "refs/heads/main" and
            os.environ.get("GITHUB_EVENT_NAME") in ("push", "workflow_dispatch"), "Publication is restricted to this repository's main workflow")
    require(publication.get("schemaVersion") == 1 and
            re.fullmatch(r"[a-z][a-z0-9-]{7,95}", publication.get("requestId", "")) and
            publication.get("sourceCommit") == os.environ.get("GITHUB_SHA") and
            publication.get("workflowRunId") == os.environ.get("GITHUB_RUN_ID") and
            re.fullmatch(r"v\d+\.\d+\.\d+-preview", publication.get("tag", "")), "Publication provenance mismatch")
    for asset in publication["assets"]:
        require(Path(asset["name"]).name == asset["name"] and fingerprint(output / asset["name"]) ==
                {key: asset[key] for key in ("bytes", "sha256")}, "Prepared release asset changed")
    require(fingerprint(output / "release-body.md")["sha256"] == publication["bodySha256"], "Prepared release body changed")
    base, tag = f"/repos/{REPOSITORY}", publication["tag"]
    ref = client.request("GET", base + "/git/ref/tags/" + tag, missing_ok=True)
    existing = client.request("GET", base + "/releases/tags/" + tag, missing_ok=True)
    body = (output / "release-body.md").read_text()
    if existing is not None and not existing.get("draft"):
        require(existing.get("prerelease") is True and ref is not None and
                ref.get("object", {}).get("sha") == publication["sourceCommit"] and
                existing.get("body") == body,
                "Existing release/tag is immutable and differs from this request")
        verify_remote_assets(existing, publication)
        return {"status": "already-published-identical", "html_url": existing["html_url"]}
    draft = existing
    if draft is None:
        # A draft may have no tag ref and may not be returned by the tag endpoint.
        for page in range(1, 101):
            releases = client.request("GET", base + f"/releases?per_page=100&page={page}")
            matches = [item for item in releases if item.get("tag_name") == tag]
            require(len(matches) <= 1, "Ambiguous existing release request")
            if matches:
                draft = matches[0]
                break
            if len(releases) < 100:
                break
        else:
            raise ValueError("Release inventory exceeds the bounded preflight")
    present = set()
    if draft is not None:
        # Resume only this exact partial draft. Existing bytes are never replaced.
        require(draft.get("draft") is True and draft.get("prerelease") is True and
                draft.get("tag_name") == tag and draft.get("target_commitish") == publication["sourceCommit"] and
                draft.get("name") == publication["name"] and draft.get("body") == body and
                (ref is None or ref.get("object", {}).get("sha") == publication["sourceCommit"]),
                "Existing draft/tag differs from the verified release request")
        present = verify_remote_assets(draft, publication, allow_partial=True)
    else:
        require(ref is None, "An existing tag cannot be reused or overwritten")
        draft = client.request("POST", base + "/releases", {"tag_name": tag,
            "target_commitish": publication["sourceCommit"], "name": publication["name"],
            "body": body, "draft": True, "prerelease": True, "make_latest": "false"})
    require(draft.get("draft") is True and draft.get("tag_name") == tag, "GitHub did not create the expected draft")
    release_id = draft["id"]
    for asset in publication["assets"]:
        name = asset["name"]
        if name in present:
            continue
        uploaded = client.request("POST", base + f"/releases/{release_id}/assets?name=" + urllib.parse.quote(name, safe=""),
                                  (output / name).read_bytes(), mimetypes.guess_type(name)[0] or "application/octet-stream")
        require(uploaded.get("name") == name and uploaded.get("state") == "uploaded" and
                uploaded.get("size") == asset["bytes"] and uploaded.get("digest") == "sha256:" + asset["sha256"],
                "Uploaded asset digest mismatch; draft left unpublished")
    staged = client.request("GET", base + f"/releases/{release_id}")
    verify_remote_assets(staged, publication)
    released = client.request("PATCH", base + f"/releases/{release_id}", {"draft": False, "prerelease": True, "make_latest": "false"})
    require(released.get("draft") is False and released.get("prerelease") is True and released.get("tag_name") == tag,
            "GitHub did not confirm the prerelease")
    verify_remote_assets(released, publication)
    ref = client.request("GET", base + "/git/ref/tags/" + tag)
    require(ref.get("object", {}).get("sha") == publication["sourceCommit"], "Published tag points at another source")
    return {"status": "published", "html_url": released["html_url"]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("gate", "prepare", "publish"))
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--device-directory", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.command == "gate":
        gate(args.root)
    elif args.command == "prepare":
        require(args.directory and args.device_directory and args.output, "Prepare requires artifact, device and output directories")
        result = prepare(args.root, args.directory, args.device_directory, args.output)
        print(json.dumps({"tag": result["tag"], "assets": [asset["name"] for asset in result["assets"]]}))
    else:
        require(args.output and os.environ.get("GITHUB_TOKEN"), "Publish requires output and a job-scoped GitHub token")
        result = publish(args.output, GitHub(os.environ["GITHUB_TOKEN"]))
        print(json.dumps(result))
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as stream:
                stream.write(f"## Android preview\n\n[{result['status']}]({result['html_url']})\n")


if __name__ == "__main__":
    main()
