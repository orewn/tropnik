#!/usr/bin/env python3
"""Require real connected-test cases; an empty Gradle/report run is not proof."""
from __future__ import annotations

import argparse
import datetime
import json
import os
from pathlib import Path
import xml.etree.ElementTree as ET

EXPECTED = {
    "canOpenRegionAndReadOfficialRestrictionWithoutAnAccount",
    "noServerMeansExplicitConfigurationNotInventedSocialActivity",
    "bundledLandscapeCanOpenAndReturnToTheSameRoute",
    "rendererExitHandlerReleasesTheViewAndKeepsNativeRouteAvailable",
    "terminalDocumentFailureAfterFirstFrameCanPrepareANewView",
}
CLASS_NAME = "ru.tropa.app.LocalExperienceTest"


def inspect(directory: Path, gradle_exit: int) -> dict:
    files = sorted(directory.rglob("TEST-*.xml")) if directory.is_dir() else []
    cases = []
    parse_errors = []
    for path in files:
        try:
            tree = ET.parse(path)
            for item in tree.iter("testcase"):
                cases.append({"className": item.get("classname", ""), "name": item.get("name", ""),
                              "failed": item.find("failure") is not None,
                              "error": item.find("error") is not None,
                              "skipped": item.find("skipped") is not None})
        except (ET.ParseError, OSError) as error:
            parse_errors.append({"path": str(path.relative_to(directory)), "error": type(error).__name__})
    actual = {item["name"] for item in cases if item["className"] == CLASS_NAME}
    failures = sum(item["failed"] for item in cases)
    errors = sum(item["error"] for item in cases)
    skipped = sum(item["skipped"] for item in cases)
    passed = (gradle_exit == 0 and not parse_errors and len(cases) == len(EXPECTED)
              and actual == EXPECTED and not failures and not errors and not skipped
              and all(item["className"] == CLASS_NAME for item in cases))
    return {"recordedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "status": "passed" if passed else "failed", "gradleExitCode": gradle_exit,
            "deviceExecutionVerified": passed, "physicalDeviceVerified": False,
            "environment": "GitHub-hosted Ubuntu / Android API 35 x86_64 / KVM / SwiftShader",
            "sourceCommit": os.environ.get("GITHUB_SHA"), "workflowRunId": os.environ.get("GITHUB_RUN_ID"),
            "reportFiles": [str(path.relative_to(directory)) for path in files],
            "tests": len(cases), "failures": failures, "errors": errors, "skipped": skipped,
            "missingTests": sorted(EXPECTED - actual), "parseErrors": parse_errors, "cases": cases,
            "note": "Execution proof requires all five actual JUnit cases and a successful connected Gradle task. This is not physical GPU, GPS, battery, or production API validation."}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--gradle-exit", type=int, required=True)
    args = parser.parse_args()
    report = inspect(args.directory, args.gradle_exit)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({key: report[key] for key in ("status", "tests", "failures", "errors", "skipped", "deviceExecutionVerified")}))
    raise SystemExit(0 if report["deviceExecutionVerified"] else 1)


if __name__ == "__main__":
    main()
