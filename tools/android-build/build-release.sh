#!/usr/bin/env bash
set -euo pipefail
umask 077
tropnik_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tropnik_sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
tropnik_options=()
tropnik_directory=release-candidate
if [[ "${1:-}" == "--unsigned-check" && $# == 1 ]]; then
  tropnik_options+=(--unsigned-check)
  tropnik_directory=release-check
elif [[ $# != 0 ]]; then
  printf '%s\n' 'Usage: build-release.sh [--unsigned-check]' >&2
  exit 2
fi
if [[ -z "$tropnik_sdk" || ! -x "$tropnik_sdk/build-tools/36.0.0/apksigner" ]]; then
  printf '%s\n' 'Android SDK platform 36 and build-tools 36.0.0 are required.' >&2
  exit 1
fi
python3 "$tropnik_root/tools/android-build/verify-production.py" preflight "${tropnik_options[@]}"
tropnik_source="$(python3 -c 'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from preview_artifacts import source_checkout; print(source_checkout(Path(sys.argv[2]), require_clean=True))' "$tropnik_root/tools/android-build" "$tropnik_root")"
node "$tropnik_root/tools/android-build/prepare-catalog.mjs" --check
python3 "$tropnik_root/tools/android-build/prepare-landscape.py" --check
node "$tropnik_root/tools/android-build/prepare-custom-map.mjs" --check
tropnik_output="$tropnik_root/android/$tropnik_directory"
if [[ -e "$tropnik_output" ]]; then
  printf '%s\n' 'The candidate output directory already exists; retain or move the prior result first.' >&2
  exit 1
fi
mkdir -m 700 "$tropnik_output"
cd "$tropnik_root/android"
# No credential values are placed in arguments or reports. Gradle reads the
# external environment. Never call the preview optimizer/signing path here.
"${TROPNIK_GRADLE:-./gradlew}" --no-daemon --console=plain :app:assembleRelease
tropnik_apk=app/build/outputs/apk/release/app-release.apk
if [[ ${#tropnik_options[@]} == 1 ]]; then
  tropnik_apk=app/build/outputs/apk/release/app-release-unsigned.apk
fi
# Verify the private candidate copy that will actually be delivered, not a
# mutable Gradle output followed by a later unverified copy.
tropnik_candidate="$tropnik_output/tropnik-$tropnik_directory.apk"
cp -- "$tropnik_apk" "$tropnik_candidate"
python3 "$tropnik_root/tools/android-build/verify-production.py" verify "${tropnik_options[@]}" \
  --apk "$tropnik_candidate" --sdk "$tropnik_sdk" --expected-source "$tropnik_source" --output "$tropnik_output/production-verification.json"
printf '%s\n' "Verified candidate in $tropnik_output; no publication or device execution performed."
