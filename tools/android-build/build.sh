#!/usr/bin/env bash
set -euo pipefail

# Run from any directory with a normal JDK 17+ and Android SDK installed.
tropnik_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tropnik_sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
tropnik_output="${TROPNIK_APK_OUTPUT:-$tropnik_root/android/dist}"
if [[ -z "$tropnik_sdk" || ! -x "$tropnik_sdk/build-tools/36.0.0/apksigner" ]]; then
  printf '%s\n' 'Install Android SDK platform 36 and build-tools 36.0.0; set ANDROID_HOME.' >&2
  exit 1
fi
mkdir -p "$tropnik_output"
node "$tropnik_root/tools/android-build/prepare-catalog.mjs"
python3 "$tropnik_root/tools/android-build/prepare-landscape.py"
node "$tropnik_root/tools/android-build/prepare-catalog.mjs" --check
python3 "$tropnik_root/tools/android-build/prepare-landscape.py" --check
python3 -m unittest discover -s "$tropnik_root/tools/android-build" -p 'test_*.py'
node --test "$tropnik_root/tools/android-build/test-landscape-bootstrap.mjs"
cd "$tropnik_root/android"
tropnik_gradle="${TROPNIK_GRADLE:-./gradlew}"
tropnik_gradle_flags=(--no-daemon --console=plain)
if [[ "${TROPNIK_GRADLE_OFFLINE:-0}" == "1" ]]; then tropnik_gradle_flags+=(--offline); fi

# signingReport is the authoritative debug store location; do not assume ~/.android.
# Keep this local process metadata out of the published artifact directory.
tropnik_signing_report="$(mktemp "${TMPDIR:-/tmp}/tropnik-debug-signing.XXXXXX")"
trap 'rm -f -- "$tropnik_signing_report"' EXIT
"$tropnik_gradle" "${tropnik_gradle_flags[@]}" :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest :app:signingReport | tee "$tropnik_signing_report"
python3 "$tropnik_root/tools/android-build/collect-test-results.py" app/build/test-results/testDebugUnitTest "$tropnik_output/unit-tests.json"
python3 "$tropnik_root/tools/android-build/optimize-preview-apk.py" app/build/outputs/apk/debug/app-debug.apk "$tropnik_output/tropnik-preview.apk" --sdk "$tropnik_sdk" --signing-report "$tropnik_signing_report" --report "$tropnik_output/tropnik-preview.compression.json"
cp app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk "$tropnik_output/tropnik-instrumentation-tests.apk"
"$tropnik_gradle" "${tropnik_gradle_flags[@]}" :app:assembleDebug -PtargetAbi=arm64-v8a
python3 "$tropnik_root/tools/android-build/optimize-preview-apk.py" app/build/outputs/apk/debug/app-debug.apk "$tropnik_output/tropnik-arm64-preview.apk" --sdk "$tropnik_sdk" --signing-report "$tropnik_signing_report" --report "$tropnik_output/tropnik-arm64-preview.compression.json"

for tropnik_apk in "$tropnik_output/tropnik-preview.apk" "$tropnik_output/tropnik-arm64-preview.apk"; do
  "$tropnik_sdk/build-tools/36.0.0/apksigner" verify --verbose --print-certs "$tropnik_apk" > "${tropnik_apk%.apk}.signature.txt"
  "$tropnik_sdk/build-tools/36.0.0/zipalign" -c -v -P 16 4 "$tropnik_apk" > "${tropnik_apk%.apk}.alignment.txt"
  "$tropnik_sdk/build-tools/36.0.0/aapt2" dump badging "$tropnik_apk" > "${tropnik_apk%.apk}.manifest.txt"
  python3 "$tropnik_root/tools/android-build/verify-apk.py" "$tropnik_apk" --output "${tropnik_apk%.apk}.verification.json"
done
printf '%s\n' "Verified preview APKs: $tropnik_output"
