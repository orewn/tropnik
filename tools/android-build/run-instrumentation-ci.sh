#!/usr/bin/env bash
set -euo pipefail

# Deliberately CI-only: this workflow owns one disposable AVD. Never probe
# or replace a developer's device, and never fall back to slow CPU emulation.
if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
  printf '%s\n' 'This bounded runner is only for the GitHub Actions device job.' >&2
  exit 2
fi
tropnik_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tropnik_sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
tropnik_output="$tropnik_root/android/dist/instrumentation-ci"
tropnik_artifacts="$tropnik_root/android/dist"
tropnik_adb="$tropnik_sdk/platform-tools/adb"
tropnik_emulator="$tropnik_sdk/emulator/emulator"
tropnik_serial='emulator-5554'
mkdir -p "$tropnik_output"
python3 "$tropnik_root/tools/android-build/preview_artifacts.py" verify --directory "$tropnik_artifacts" --root "$tropnik_root" --sdk "$tropnik_sdk"
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
# Linux's legacy SwiftShader GLES misreads MapLibre uniform blocks (#4625),
# producing blue/transparent symbols. SwANGLE keeps the shipped OpenGL renderer
# and runs its GLSL through ANGLE over software SwiftShader Vulkan instead.
# https://developer.android.com/studio/run/emulator-acceleration
"$tropnik_emulator" -avd tropnik-ci-api35 -port 5554 -accel on -gpu swangle \
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
# Retain the observed driver, and reject a silent fallback to the legacy GLES
# path before installing/running the eight pixel and interaction cases.
timeout 10s "$tropnik_adb" -s "$tropnik_serial" shell dumpsys SurfaceFlinger > "$tropnik_output/graphics-driver.txt"
python3 - "$tropnik_root" "$tropnik_output/graphics-driver.txt" <<'PY'
import importlib.util
import json
from pathlib import Path
import sys
path = Path(sys.argv[1]) / "tools/android-build/check-instrumentation.py"
sys.path.insert(0, str(path.parent))
spec = importlib.util.spec_from_file_location("graphics_check", path)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)
print(json.dumps(checker.graphics_driver(Path(sys.argv[2]))))
PY
"$tropnik_adb" -s "$tropnik_serial" shell settings put global window_animation_scale 0
"$tropnik_adb" -s "$tropnik_serial" shell settings put global transition_animation_scale 0
"$tropnik_adb" -s "$tropnik_serial" shell settings put global animator_duration_scale 0
"$tropnik_adb" -s "$tropnik_serial" shell input keyevent 82
"$tropnik_adb" -s "$tropnik_serial" logcat -c

# Install the optimized universal APK and test APK produced by the build job.
# Never invoke Gradle here: rebuilding would test different bytes and a new key.
"$tropnik_adb" -s "$tropnik_serial" install --no-incremental -r -t "$tropnik_artifacts/tropnik-preview.apk"
"$tropnik_adb" -s "$tropnik_serial" install --no-incremental -r -t "$tropnik_artifacts/tropnik-instrumentation-tests.apk"
python3 "$tropnik_root/tools/android-build/preview_artifacts.py" installed --directory "$tropnik_artifacts" --root "$tropnik_root" --sdk "$tropnik_sdk" --serial "$tropnik_serial" --output "$tropnik_output/installed-apks.json"
# A boot-time Pixel Launcher ANR blocked real MotionEvent delivery in API 35.
# Recover only that exact active system window before starting the app tests.
python3 "$tropnik_root/tools/android-build/device-preflight.py" \
  --adb "$tropnik_adb" --serial "$tropnik_serial" --output "$tropnik_output"
set +e
timeout --signal=TERM --kill-after=30s 12m "$tropnik_adb" -s "$tropnik_serial" shell am instrument -w -r \
  -e class ru.tropa.app.LocalExperienceTest \
  ru.tropa.app.preview.test/androidx.test.runner.AndroidJUnitRunner \
  2>&1 | tee "$tropnik_output/raw-instrumentation.log"
tropnik_instrumentation_exit=${PIPESTATUS[0]}
set -e
sha256sum "$tropnik_artifacts/tropnik-preview.apk" "$tropnik_artifacts/tropnik-instrumentation-tests.apk" > "$tropnik_output/tested-apks.sha256"
python3 "$tropnik_root/tools/android-build/check-instrumentation.py" \
  "$tropnik_output/raw-instrumentation.log" "$tropnik_output/device-result.json" \
  --process-exit "$tropnik_instrumentation_exit" --artifact-directory "$tropnik_artifacts" \
  --installed-report "$tropnik_output/installed-apks.json" --root "$tropnik_root"
