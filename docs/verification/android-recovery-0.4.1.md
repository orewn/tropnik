# Android 0.4.1 — исправления и проверка

Версия `0.4.1-preview`, code 5. Два подтверждённых дефекта исправлены; ARM64 и универсальный APK собраны и проверены. Машиночитаемый receipt — `android-recovery-0.4.1.json`.

## Что изменено

Terminal graphics failure освобождает renderer, снимает готовность и требует новой графической сессии. Веб создаёт новый canvas; Android удаляет сломанный WebView и повторно загружает проверенный локальный документ. Поздние callbacks не возвращают `ready`. Скрытая готовая сцена остаётся приостановленной.

Короткая публикация офлайн-пакета в Room и отметка владения защищены от отмены. Отмена копирования продолжает распространяться вызывающему коду; каталог, на который уже указывает база, не удаляется обработчиком отмены. Очистка предыдущей копии не откатывает новую.

## Фактическая проверка

- 25 JVM, 15 Python asset, 6 native bootstrap, 18 renderer и 4 standalone bootstrap: пройдены.
- Пять instrumentation сценариев скомпилированы; на устройстве не запускались.
- Оба APK: подпись v2, ZIP alignment16K, ELF alignment и ресурсы проверены.
- API origin в скомпилированном BuildConfig пустой; конфигурация, ApiClient, OnlineViewModel и network-security конфигурация совпадают с 0.4.0.
- ARM64 на странице загрузки и его manifest совпадают с фактическими байтами APK.

## Подготовленный CI

Отдельная задача `instrumentation` запускается только вручную с `run_instrumentation=true` после успешной задачи build. Один API35 x86_64 AVD, Ubuntu/KVM, SwiftShader; максимум25 минут. Пустые/ошибочные/неполные отчёты не проходят gate. YAML/shell syntax и восемь синтетических fixtures проверены. Workflow не запускался; device execution остаётся неподтверждённым.

## Обзорный рельеф РФ и очередь веб-отмывки

В финальную сборку включён локальный обзорный слой Natural Earth:341PNG, z0–4, скрытие отzoom6. Полный source/native пакет —344файла,1 759 234байта; источник и ограничения проверены в обоих APK. Это не DEM и не подробная карта троп всей РФ. Дополнительный веб-fix ограничил Canvas очередь тремя загрузками и одним decode;8 регрессионных и3 height-shading теста прошли.

## Полный список изменённых исходников

| Путь | Статус |
|---|---|
| `.github/workflows/android.yml` | modified |
| `android/BUILD-VERIFICATION.md` | modified |
| `android/README.md` | modified |
| `android/app/build.gradle.kts` | modified |
| `android/app/src/androidTest/java/ru/tropa/app/LocalExperienceTest.kt` | modified |
| `android/app/src/main/assets/SOURCES.txt` | modified |
| `android/app/src/main/assets/catalog.json` | modified |
| `android/app/src/main/assets/landscape/landscape.html` | modified |
| `android/app/src/main/assets/landscape/manifest.json` | modified |
| `android/app/src/main/assets/maps/style.json` | modified |
| `android/app/src/main/java/ru/tropa/app/MainViewModel.kt` | modified |
| `android/app/src/main/java/ru/tropa/app/data/OfflinePackPublication.kt` | added |
| `android/app/src/main/java/ru/tropa/app/data/OfflinePacks.kt` | modified |
| `android/app/src/main/java/ru/tropa/app/ui/LocalLandscapeScene.kt` | modified |
| `android/app/src/main/java/ru/tropa/app/ui/TropaApp.kt` | modified |
| `android/app/src/main/java/ru/tropa/app/ui/TropaMap.kt` | modified |
| `android/app/src/test/java/ru/tropa/app/data/OfflinePackPublicationTest.kt` | added |
| `docs/verification/android-instrumentation-workflow-check.json` | added |
| `docs/verification/android-recovery-final-packages.json` | added |
| `docs/verification/android-unit-tests-0.4.1.json` | added |
| `docs/verification/canvas-relief-queue-fix.json` | added |
| `docs/verification/native-russia-relief-source.json` | added |
| `docs/verification/native-russia-relief-source.md` | added |
| `tools/android-build/check-instrumentation.py` | added |
| `tools/android-build/github-actions.yml` | modified |
| `tools/android-build/prepare-landscape.py` | modified |
| `tools/android-build/run-instrumentation-ci.sh` | added |
| `tools/android-build/russia_relief.py` | added |
| `tools/android-build/test-landscape-bootstrap.mjs` | modified |
| `tools/android-build/test_landscape_assets.py` | modified |
| `tools/android-build/test_russia_relief.py` | added |
| `tools/android-build/verify-apk.py` | modified |
| `web/components/TerrainScene.tsx` | modified |
| `web/lib/canvas-relief.ts` | added |
| `web/public/downloads/android-manifest.json` | modified |
| `web/public/terrain/landscape.html` | modified |
| `web/public/terrain/terrain-renderer.d.ts` | modified |
| `web/public/terrain/terrain-renderer.js` | modified |
| `web/scripts/build-landscape.mjs` | modified |
| `web/scripts/landscape-bootstrap.js` | modified |
| `web/scripts/landscape-shell.css` | modified |
| `web/tests/canvas-relief.test.mjs` | added |
| `web/tests/landscape-bootstrap.test.mjs` | modified |
| `web/tests/terrain-renderer.test.mjs` | modified |
| `android/app/src/main/assets/maps/russia-relief/` — все344файла | added |

Полный пофайловый список (включая все341PNG) и SHA256 находятся в JSON receipt. Этот Markdown и сам receipt добавлены отдельно. Бинарные APK и отчёты `android/dist/` не включаются в GitHub-исходники; hashes приведены в build report.
