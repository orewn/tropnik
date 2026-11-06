#!/usr/bin/env bash
set -euo pipefail

# Deliberately CI-only: a manual workflow owns one disposable AVD. Never probe
# or replace a developer's device, and never fall back to slow CPU emulation.
if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
  printf '%s\n' 'This bounded runner is only for the manual GitHub Actions job.' >&2
  exit 2
fi
tropnik_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tropnik_sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
tropnik_output="$tropnik_root/android/dist/instrumentation-ci"
tropnik_adb="$tropnik_sdk/platform-tools/adb"
tropnik_emulator="$tropnik_sdk/emulator/emulator"
tropnik_serial='emulator-5554'
mkdir -p "$tropnik_output"
[[ -r /dev/kvm && -w /dev/kvm ]]
# Keep preflight diagnostics in both the job log and the retained artifact.
# pipefail preserves a launcher/linker failure instead of letting tee mask it.
"$tropnik_emulator" -accel-check 2>&1 | tee "$tropnik_output/acceleration.txt"
"$tropnik_emulator" -version 2>&1 | tee "$tropnik_output/emulator-version.txt"
cp "$tropnik_sdk/system-images/android-35/google_apis/x86_64/source.properties" "$tropnik_output/system-image.properties"

tropnik_emulator_pid=''
cleanup() {
  set +e
  timeout 10s "$tropnik_adb" -s "$tropnik_serial" logcat -d -v threadtime > "$tropnik_output/logcat.txt" 2>&1
  timeout 10s "$tropnik_adb" -s "$tropnik_serial" shell dumpsys webviewupdate > "$tropnik_output/webview-version.txt" 2>&1
  timeout 10s "$tropnik_adb" -s "$tropnik_serial" exec-out screencap -p > "$tropnik_output/final-screen.png" 2>/dev/null
  timeout 10s "$tropnik_adb" -s "$tropnik_serial" exec-out run-as ru.tropa.app.preview tar -cf - -C files qa > "$tropnik_output/test-screenshots.tar" 2>/dev/null
  timeout 10s "$tropnik_adb" -s "$tropnik_serial" emu kill > /dev/null 2>&1
  if [[ -n "$tropnik_emulator_pid" ]]; then kill "$tropnik_emulator_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

"$tropnik_adb" start-server
"$tropnik_emulator" -avd tropnik-ci-api35 -port 5554 -accel on -gpu swiftshader \
  -no-window -no-audio -no-boot-anim -no-snapshot -wipe-data -memory 2048 -cores 2 \
  -camera-back none -camera-front none > "$tropnik_output/emulator.log" 2>&1 &
tropnik_emulator_pid=$!
tropnik_deadline=$((SECONDS + 240))
tropnik_booted='false'
while ((SECONDS < tropnik_deadline)); do
  if ! kill -0 "$tropnik_emulator_pid" 2>/dev/null; then break; fi
  tropnik_boot="$(timeout 5s "$tropnik_adb" -s "$tropnik_serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
  if [[ "$tropnik_boot" == '1' ]]; then tropnik_booted='true'; break; fi
  sleep 2
done
if [[ "$tropnik_booted" != 'true' ]]; then
  printf '%s\n' 'The KVM emulator did not boot within 240 seconds; no device test is claimed.' >&2
  exit 1
fi
"$tropnik_adb" -s "$tropnik_serial" shell settings put global window_animation_scale 0
"$tropnik_adb" -s "$tropnik_serial" shell settings put global transition_animation_scale 0
"$tropnik_adb" -s "$tropnik_serial" shell settings put global animator_duration_scale 0
"$tropnik_adb" -s "$tropnik_serial" shell input keyevent 82
"$tropnik_adb" -s "$tropnik_serial" logcat -c

cd "$tropnik_root/android"
chmod +x gradlew
set +e
timeout --signal=TERM --kill-after=30s 12m ./gradlew --no-daemon --console=plain --max-workers=2 \
  :app:connectedDebugAndroidTest -PapiBaseUrl= \
  -Pandroid.testInstrumentationRunnerArguments.class=ru.tropa.app.LocalExperienceTest \
  2>&1 | tee "$tropnik_output/connected-tests.log"
tropnik_gradle_exit=${PIPESTATUS[0]}
set -e
python3 "$tropnik_root/tools/android-build/check-instrumentation.py" \
  app/build/outputs/androidTest-results/connected "$tropnik_output/device-result.json" \
  --gradle-exit "$tropnik_gradle_exit"
sha256sum app/build/outputs/apk/debug/app-debug.apk \
  app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk > "$tropnik_output/tested-apks.sha256"
