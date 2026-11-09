#!/usr/bin/env python3
"""Require all actual raw AndroidJUnitRunner cases for the installed artifact.

adb's exit code alone does not report test failures. The raw protocol is defined
by AndroidX InstrumentationResultPrinter; start/completion pairs and the final
instrumentation result are checked independently, before binding the APK hashes.
"""
from __future__ import annotations

import argparse
import datetime
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

from preview_artifacts import (RECEIPT, TEST_APK, UNIVERSAL, fingerprint,
                               read_json, require, verify_receipt)

EXPECTED = {
    "canOpenRegionAndReadOfficialRestrictionWithoutAnAccount",
    "noServerMeansExplicitConfigurationNotInventedSocialActivity",
    "bundledLandscapeCanOpenAndReturnToTheSameRoute",
    "rendererExitHandlerReleasesTheViewAndKeepsNativeRouteAvailable",
    "terminalDocumentFailureAfterFirstFrameCanPrepareANewView",
    "browserPlannerExplainsStorageAndCanCancelWithoutLeavingTheApp",
}
CLASS_NAME = "ru.tropa.app.LocalExperienceTest"


def inspect_raw(text: str, process_exit: int) -> dict:
    cases, parse_errors, final_codes = [], [], []
    current = {}
    started, finished = set(), set()
    for line in text.splitlines():
        line = line.rstrip("\r")
        match = re.fullmatch(r"INSTRUMENTATION_STATUS: ([A-Za-z][A-Za-z0-9_]*)=(.*)", line)
        if match:
            key, value = match.groups()
            if key in current:
                parse_errors.append("Duplicate status field: " + key)
            current[key] = value
            continue
        match = re.fullmatch(r"INSTRUMENTATION_STATUS_CODE: (-?\d+)", line)
        if match:
            code = int(match[1])
            name, classname = current.get("test", ""), current.get("class", "")
            identity = (classname, name)
            if current.get("id") != "AndroidJUnitRunner" or current.get("numtests") != str(len(EXPECTED)):
                parse_errors.append("Unexpected runner or declared test count")
            if classname != CLASS_NAME or name not in EXPECTED:
                parse_errors.append("Unexpected test case")
            if code == 1:
                if identity in started or identity in finished:
                    parse_errors.append("Repeated test start")
                started.add(identity)
            else:
                if identity not in started or identity in finished:
                    parse_errors.append("Completion without one matching start")
                if code not in (0, -1, -2, -3, -4):
                    parse_errors.append("Unknown test result code")
                finished.add(identity)
                cases.append({"className": classname, "name": name, "statusCode": code,
                              "failed": code == -2, "error": code == -1,
                              "skipped": code in (-3, -4)})
            current = {}
            continue
        match = re.fullmatch(r"INSTRUMENTATION_CODE: (-?\d+)", line)
        if match:
            final_codes.append(int(match[1]))
        elif line.startswith(("INSTRUMENTATION_FAILED", "INSTRUMENTATION_ABORTED")):
            parse_errors.append("Runner failed or aborted")
        elif line.startswith("INSTRUMENTATION_RESULT: shortMsg=") or line.startswith("INSTRUMENTATION_RESULT: longMsg="):
            parse_errors.append("Runner reported an error")
    if current:
        parse_errors.append("Truncated status block")
    if started != finished:
        parse_errors.append("Test started without completion")
    expected = {(CLASS_NAME, name) for name in EXPECTED}
    failures, errors, skipped = (sum(case[key] for case in cases) for key in ("failed", "error", "skipped"))
    passed = (process_exit == 0 and not parse_errors and final_codes == [-1]
              and len(cases) == len(EXPECTED) and finished == expected
              and not failures and not errors and not skipped)
    return {"status": "passed" if passed else "failed", "processExitCode": process_exit,
            "instrumentationResultCodes": final_codes, "deviceExecutionVerified": passed,
            "tests": len(cases), "failures": failures, "errors": errors, "skipped": skipped,
            "missingTests": sorted(name for classname, name in expected - finished),
            "parseErrors": parse_errors, "cases": cases}


def bind_artifact(report: dict, directory: Path, root: Path, installed_path: Path):
    build = verify_receipt(directory, root)
    installed = read_json(installed_path)
    digest = fingerprint(directory / RECEIPT)["sha256"]
    require(installed.get("schemaVersion") == 1 and installed.get("installedArtifactBytesVerified") is True,
            "No installed APK byte verification")
    require(installed.get("sourceCommit") == build["sourceCommit"] and
            installed.get("workflowRunId") == build["workflowRunId"] and
            installed.get("buildReceiptSha256") == digest, "Installed receipt belongs to another build")
    require(installed.get("installedApks") == {name: build["files"][name] for name in (UNIVERSAL, TEST_APK)},
            "Installed APKs are not the build artifacts")
    report.update({"schemaVersion": 2, "recordedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   "sourceCommit": build["sourceCommit"], "workflowRunId": build["workflowRunId"],
                   "buildReceiptSha256": digest, "testedApks": installed["installedApks"],
                   "installedArtifactBytesVerified": True,
                   "releasePayloadDeviceVerified": report["deviceExecutionVerified"],
                   "testedArchitecture": "x86_64", "testedArtifact": UNIVERSAL,
                   "arm64DeviceExecutionVerified": False, "physicalDeviceVerified": False,
                   "environment": "GitHub-hosted Ubuntu / Android API 35 x86_64 / KVM / SwiftShader",
                   "note": "All six actual cases must pass on the exact installed universal preview. ARM64, physical GPU, GPS, battery and a production API are not device-verified."})
    return report


def write_junit(report, output):
    suite = ET.Element("testsuite", {"name": CLASS_NAME, **{key: str(report[key]) for key in ("tests", "failures", "errors", "skipped")}})
    for case in report["cases"]:
        item = ET.SubElement(suite, "testcase", {"classname": case["className"], "name": case["name"]})
        for field, tag in (("failed", "failure"), ("error", "error"), ("skipped", "skipped")):
            if case[field]:
                ET.SubElement(item, tag).text = "See raw-instrumentation.log for AndroidJUnitRunner diagnostics."
    ET.ElementTree(suite).write(output, encoding="utf-8", xml_declaration=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("raw_log", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--process-exit", type=int, required=True)
    parser.add_argument("--artifact-directory", type=Path, required=True)
    parser.add_argument("--installed-report", type=Path, required=True)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    require(args.raw_log.is_file() and args.raw_log.stat().st_size <= 20_000_000, "Missing or oversized runner log")
    report = inspect_raw(args.raw_log.read_text(errors="replace"), args.process_exit)
    try:
        bind_artifact(report, args.artifact_directory, args.root, args.installed_report)
    except (ValueError, OSError, KeyError) as error:
        report.update({"status": "failed", "deviceExecutionVerified": False, "releasePayloadDeviceVerified": False,
                       "artifactError": str(error)})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    write_junit(report, args.output.with_name("TEST-LocalExperienceTest.xml"))
    print(json.dumps({key: report[key] for key in ("status", "tests", "failures", "errors", "skipped", "deviceExecutionVerified")}))
    raise SystemExit(0 if report["deviceExecutionVerified"] else 1)


if __name__ == "__main__":
    main()
