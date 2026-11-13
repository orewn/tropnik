# Production-сборка Android

Этот путь готовит проверяемый кандидат, но не публикует приложение и не заменяет
испытания подписанного APK. Предварительные сборки продолжают использовать
`ru.tropa.app.preview`; постоянная production identity — `ru.tropa.app`.
Приложения могут быть установлены рядом и имеют раздельное локальное хранилище.
Переименование package не переносит данные из preview автоматически.

## Что проверяет CI без ключей

После preview-сборки workflow собирает `:app:assembleRelease` с R8 и shrinkResources.
Android Components API задаёт release applicationId и имя версии без `-preview`;
preview-задачи, package и debug-сертификат не меняются. `build-release.sh --unsigned-check`
не принимает production signing credentials, проверяет release manifest, отсутствие
debuggable, SDK 26/36, universal ABI, ZIP/ELF alignment и действующие проверки всего
картографического payload. Receipt называется `unsigned-production-build-check` и
явно содержит `signatureVerified:false`, `deviceExecutionVerified:false`,
`productionPublished:false` и `liveApiVerified:false`.

Все исходные assets сверяются побайтно с checkout; допускаются только два
дополнительных бинарных ART-профиля, которые AGP создаёт из библиотек
(`baseline.prof` / `baseline.profm`). Они должны побайтно совпадать с выходами
`compileReleaseArtProfile` этого Gradle build. Заголовки проверяются; размеры и SHA-256
записываются отдельно. Проверяется именно приватная копия кандидата: hash до и после всех
проверок и commit до и после Gradle должны совпасть.

Для диагностики сохраняется `production-diagnostics.json`: относительные пути,
размеры, SHA-256 и восьмибайтовые заголовки APK dexopt-файлов и выходов задачи
`compileReleaseArtProfile`. Отчёт ограничен по числу файлов и объёму чтения;
содержимого файлов и signing inputs в нём нет. Он сохраняется и при отказе gate,
но не заменяет `production-verification.json` и не разрешает публикацию. Допуск
по-прежнему требует побайтного совпадения с двумя точными binary ART outputs.

Неподписанный APK не включается в публичные preview-ассеты. Успех этого gate
подтверждает компиляцию оптимизированного варианта и целостность его содержимого.
Успех устройства на debug APK не приписывается R8-варианту. Фактический результат
должен ссылаться на CI конкретного commit; наличие workflow не является исполнением.

## Подписанный кандидат

Проверенная среда команды использует JDK 17, Android SDK 36 / build-tools 36.0.0,
зависимости из lockfile и чистые, закоммиченные исходники с актуальными generated
assets. Постоянный ключ владелец хранит вне репозитория и отдельно резервирует.
Скрипты не создают, не заменяют и не загружают ключи. Закрытый файл keystore должен
иметь права `0600` или строже и не быть symlink.

Через защищённое окружение сборщика задаются:

| Переменная | Назначение |
| --- | --- |
| `TROPNIK_RELEASE_KEYSTORE` | Абсолютный путь к существующему приватному keystore вне checkout |
| `TROPNIK_RELEASE_STORE_PASSWORD` | Пароль хранилища |
| `TROPNIK_RELEASE_KEY_ALIAS` | Alias постоянного ключа; `AndroidDebugKey` запрещён |
| `TROPNIK_RELEASE_KEY_PASSWORD` | Пароль ключа |
| `TROPNIK_RELEASE_CERT_SHA256` | Независимо записанный SHA-256 публичного сертификата |
| `TROPA_API_BASE_URL` | HTTPS origin отдельно развёрнутого API, без credentials/query/fragment |

Не передавайте пароли в аргументах команд, issue, chat, source archive или shell
history. Для подписанной сборки из корня проекта:

```bash
bash tools/android-build/build-release.sh
```

Сначала сверяется сертификат существующего keystore с ожидаемым fingerprint.
После Gradle проверяются финальная APK-подпись v2, единственный signer,
отсутствие debug certificate, production identity, версия и содержимое. Пароли
передаются Gradle через environment, а `keytool` получает только имя переменной.
Receipt не содержит приватных ключей, паролей или содержимого keystore.

Проверка R8 разрешает `ru.tropa.app:font/manrope` через таблицу ресурсов `aapt2`
и сравнивает полные байты выбранного файла с исходным шрифтом. Сокращённое
оптимизатором имя файла допустимо только при такой связи с ресурсом; поиск
совпавшего имени или произвольного TTF не заменяет проверку. Диагностический
receipt сохраняет ограниченный фрагмент таблицы шрифтов для разбора отказа.

Результат — `android/release-candidate/`, существующий каталог не перезаписывается.
В нём находятся универсальный APK и `production-verification.json`, связывающий
байты с исходным commit. Это **signed-production-candidate**, ещё не публичный
релиз. Скрипт не вызывает preview optimizer, не подписывает release debug-ключом
и не создаёт GitHub/store release.

## Допуск к распространению

Перед первой публикацией нужно выполнить сценарии на точных байтах подписанного
R8 APK, включая запуск WebView/bridge после обфускации, offline, права, TalkBack,
вход и выход на рабочем API. Для последующих версий проверяется обновление
предыдущего production APK без удаления данных; fingerprint и versionCode должны
соответствовать принятой цепочке. Реальный API/SMTP, устройство, R8 device gate,
backup ключа и выбранный магазин/канал распространения не считаются проверенными
компиляцией CI. В текущем окружении постоянный ключ и такой production deploy
не предоставлены.

Первичные ссылки: [Android app signing](https://developer.android.com/studio/publish/app-signing),
[ApplicationVariant.applicationId](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/variant/ApplicationVariant),
[VariantOutput.versionName](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/variant/VariantOutput).
