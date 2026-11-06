#!/usr/bin/env python3
"""Summarize executed JVM tests; compiling Android tests is not running them."""
import argparse
import json
from pathlib import Path
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument("results", type=Path)
parser.add_argument("output", type=Path)
arguments = parser.parse_args()
suites = []
for source in sorted(arguments.results.glob("TEST-*.xml")):
    suite = ET.parse(source).getroot()
    suites.append({name: suite.attrib[name] for name in ("name", "tests", "failures", "errors", "skipped", "time")})
assert suites, "No executed JVM test results found"
summary = {"suites": suites, **{name: sum(int(suite[name]) for suite in suites) for name in ("tests", "failures", "errors", "skipped")},
           "instrumentationApkCompiled": True, "instrumentationExecuted": False}
arguments.output.parent.mkdir(parents=True, exist_ok=True)
arguments.output.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(summary, ensure_ascii=False))
assert summary["failures"] == 0 and summary["errors"] == 0
