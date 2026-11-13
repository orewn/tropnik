# Android 0.4.31 — проверка зависимостей и происхождения Wrapper

Дата проверки: **13 ноября 2026 года**. Это отчёт о security patch изменениях
кандидата 0.4.31, а не подтверждение публикации APK.

В рабочем дереве обновлены **Gradle 8.13 → 8.14.7** и **OkHttp 4.12.0 → 4.12.1**.
Происхождение новых файлов Wrapper подтверждено отдельным успешным CI.
**Сборка и проверки самого приложения на итоговом commit с обеими новыми
зависимостями ещё ожидаются.** Ранее полученные JVM, R8/APK и device результаты
относятся к своим исходным commit и не переносятся на новый набор зависимостей.

Предвыпускной кандидат `944bfaa2ae7509f82180b606b71506f030aabc36` прошёл
[точный CI 43388775423](https://github.com/orewn/tropnik/actions/runs/43388775423):
70 JVM, unsigned R8 и 11 сценариев API 35. Реальный DEX универсального APK
содержит `okhttp/4.12.1` и class definition `CertificateBlocklist`; старый
маркер 4.12.0 отсутствует. Gradle 8.14.7 подтверждён build log.
[Receipt](android-0.4.31-preflight.json) связывает эти результаты с точным
деревом и APK; общий main ещё должен пройти собственные gates.

## Gradle: восемь опубликованных advisories

Исходная версия 8.13 входит в диапазоны всех восьми advisories ниже. В таблице
приведены диапазоны и первые исправления для ветки **8.x**; ссылки ведут на
первичные advisories Gradle, где также указаны диапазоны 9.x.

| Опубликовано | Advisory | Уровень | Затронутая ветка 8.x / первое исправление | Условие и последствие |
|---|---|---|---|---|
| 2026-01-16 | [GHSA-mqwm-5m85-gmcv](https://github.com/gradle/gradle/security/advisories/GHSA-mqwm-5m85-gmcv) | High | `< 8.14.4` / `8.14.4` | После исчерпания повторов при отсутствии ответа Gradle переходит к следующему repository. Для подмены артефакта атакующему нужны нарушение работы первого и контроль последующего repository. |
| 2026-01-16 | [GHSA-w78c-w6vf-rw82](https://github.com/gradle/gradle/security/advisories/GHSA-w78c-w6vf-rw82) | High | `< 8.14.4` / `8.14.4` | Неразрешимый hostname пропускается. Регистрация ошибочного или просроченного домена ранее объявленного repository позволяет начать отдавать оттуда чужие артефакты. |
| 2026-10-07 | [GHSA-xwqc-3h47-hg64](https://github.com/gradle/gradle/security/advisories/GHSA-xwqc-3h47-hg64) | High | `≤ 8.14.5` / `8.14.6` | Daemon десериализует входящий Java object до проверки токена. Нужен доступ к локальному loopback-каналу работающего daemon; возможны исполнение кода или отказ в обслуживании. |
| 2026-10-07 | [GHSA-mvvg-497x-hmj8](https://github.com/gradle/gradle/security/advisories/GHSA-mvvg-497x-hmj8) | High | `≤ 8.14.5` / `8.14.6` | Канал worker → daemon не аутентифицирует peer. Локальному атакующему нужно выиграть гонку подключения при запуске worker во время сборки. |
| 2026-10-07 | [GHSA-j5m7-59rp-24f5](https://github.com/gradle/gradle/security/advisories/GHSA-j5m7-59rp-24f5) | High | `≤ 8.14.5` / `8.14.6` | Ошибки установки SSL-соединения допускают переход к следующему repository. Требуются нарушение работы первого и контроль последующего repository. |
| 2026-11-10 | [GHSA-3cfg-jpcr-gfp3](https://github.com/gradle/gradle/security/advisories/GHSA-3cfg-jpcr-gfp3) | Critical, 9.3 | `7.0–8.14.6` / `8.14.7` | Специально сформированное значение version catalog попадает в генерируемый Java-код и исполняется при загрузке accessors, в том числе при IDE sync. |
| 2026-11-10 | [GHSA-gqrr-4j89-5267](https://github.com/gradle/gradle/security/advisories/GHSA-gqrr-4j89-5267) | High, 8.6 | `≤ 8.14.6` / `8.14.7` | Клиент доверяет данным daemon registry, включая адрес и Java serialization. Подготовленный проект может переназначить registry и привести к раскрытию окружения или исполнению кода. |
| 2026-11-10 | [GHSA-pcp8-98xm-c6pr](https://github.com/gradle/gradle/security/advisories/GHSA-pcp8-98xm-c6pr) | High, 7.0 | `≤ 8.14.6` / `8.14.7` | После аварийного завершения daemon локальный атакующий может занять его порт. Клиент доверяет оставшейся записи и передаёт запрос, окружение и свойства процесса. |

По [официальным release notes](https://docs.gradle.org/8.14.7/release-notes.html)
8.14.7 выпущен **11 ноября 2026 года** и закрывает три ноябрьских проблемы.
Поэтому остановиться на 8.14.6 было бы недостаточно.

### Применимость к проекту

В проверенных Android settings используются `google()`, `mavenCentral()` и
`gradlePluginPortal()`. Строгая фильтрация содержимого repository и Gradle
dependency verification в репозитории не настроены; считать их компенсирующей
защитой для трёх repository advisories нельзя. Вместе с тем контроль атакующим
этих repositories или нарушение их работы не установлен.

Version catalogs, `org.gradle.daemon.registry.base`, `systemProp.gradle.user.home`
и сохранённый `registry.bin` в проверенных файлах не обнаружены. Это ограничивает
конкретные prerequisites ноябрьских сценариев, но не заменяет исправление
инструмента сборки. Advisories loopback-каналов требуют доступа к той же машине;
они не являются доказательством удалённой сетевой уязвимости APK.

Аудит не обнаружил свидетельств компрометации. Он также не является forensic
исследованием всех прежних CI runner и рабочих станций. Даже исправленный Gradle
не делает доверенным проект, который сам задаёт чужую daemon registry: это
ограничение прямо сохранено в advisory GHSA-gqrr-4j89-5267.

## Wrapper: официальные байты и отдельное доказательство генерации

[Официальный каталог checksums Gradle](https://gradle.org/release-checksums/)
подтверждает следующие SHA-256:

| Объект | SHA-256 |
|---|---|
| Исходный `gradle-8.13-bin.zip` | `20f1b1176237254a6fc204d8434196fa11a4cfb387567519c61556e8710aed78` |
| Исходный Wrapper JAR 8.13 | `81a82aaea5abcc8ff68b3dfcb58b3c3c429378efd98e7433460610fecd7ae45f` |
| Новый `gradle-8.14.7-bin.zip` | `903bfc4bc7622323124054c10f509246212a1902948bdaf26c379cca8735e856` |
| Новый Wrapper JAR 8.14.7 | `ad16bca46cb71bb5887c546860d93992aeee35c1fdaf4a242b0a612375d937e0` |

Исходный локальный JAR совпадал с официальным JAR 8.13. Причина обновления —
опубликованные уязвимости версии, а не обнаруженная подмена Wrapper.

[Успешный GitHub run «Verify official Gradle 8.14.7 wrapper»](https://github.com/orewn/tropnik/actions/runs/43386646262)
скачал официальный дистрибутив, проверил его SHA-256 и выполнил `wrapper` task
в пустом проекте на Temurin **17.0.21+9**. Репозиторий приложения не checkout-ился,
сборка приложения не исполнялась. Такой способ получает JAR и scripts из
проверенного генератора, а не из произвольной копии бинарного файла.

| Поле доказательства | Значение |
|---|---|
| Исходный commit workflow генерации | `a37c9860e9ed47c034dba72ecce59f48833404df` |
| Ветка генерации | `verify/gradle-wrapper-20261113` |
| Run / attempt / job | `43386646262` / `1` / `131756577874` |
| Artifact ID | `14018882690` |
| Artifact ZIP SHA-256 | `4833b81b9c8229082f291293e2614fe2098a49c73b003043e4face06e04a5de1` |
| Результат CI | `success`; только генерация и проверка происхождения Wrapper |

При независимой локальной сверке архив имел указанный SHA-256. Все четыре файла,
перенесённые в `android/`, совпали с результатом генерации:

| Файл | SHA-256 |
|---|---|
| `gradlew` | `b187b4c52e749f5760afdd6fadc31b2a98ad35fb249bf0dff03b72650f320409` |
| `gradlew.bat` | `1d297e00bd21de3ace22b4d7f2de1f9dfa858883d66bbf7c1ccbecccec8f4f3b` |
| `gradle/wrapper/gradle-wrapper.jar` | `ad16bca46cb71bb5887c546860d93992aeee35c1fdaf4a242b0a612375d937e0` |
| `gradle/wrapper/gradle-wrapper.properties` | `c4747a838d5c923931d1791ae5a56c0654e025f4c1a54e4e277f54cdc60a126f` |

Сохраняются HTTPS distribution URL, `validateDistributionUrl=true`, timeout
10 000 мс и обязательный `distributionSha256Sum`. Scripts/JAR сгенерированы
Gradle 8.14.7. Это соответствует [официальной инструкции Wrapper](https://docs.gradle.org/current/userguide/gradle_wrapper.html):
при обновлении через прежний Wrapper повторный запуск task на новой версии
нужен для обновления самих scripts/JAR.

## OkHttp: исправление доверия к скомпрометированным сертификатам

[Официальный changelog 4.x](https://lysine.dev/okhttp/changelogs/changelog_4x/)
фиксирует выпуск **4.12.1 от 22 октября 2026 года**, блокирующий восемь
скомпрометированных intermediate certificates eMudhra. Контекст инцидента
подтверждён [сообщением Google](https://blog.google/security/protecting-chrome-and-android-users-from-compromised-emudhra-intermediate-ca-certificates/).
Maintainer указывает, что устройства с Google Play Services получили
автоматическое обновление; библиотечный patch защищает JVM и AOSP, где такой
защиты может не быть. Приложение не требует GMS, поэтому наличие этой платформенной
защиты не принимается как обязательное условие безопасного подключения.

Первичный [diff `parent-4.12.0...parent-4.12.1`](https://github.com/lysine-dev/okhttp/compare/parent-4.12.0...parent-4.12.1)
содержит два commits: исправление
`e4c28adfcfa0543a31c08b9e4e713b109d9cbde6` с указанием **CVE-2026-111943** и
release commit `f5dc9a0f3a268315f9776e07507f7f97459bb9d3`. Проверенный tag
`parent-4.12.1` указывает через annotated tag
`de765a904d46635313382a33d2c1a22032bdc3f7` на этот release commit. Runtime patch
добавляет certificate blocklist в TLS path; upstream добавил проверку
`CompromisedIntermediateTest`. Подтверждение tag через GitHub API не является
заявлением о криптографической подписи Maven-артефактов.

В [app/build.gradle.kts](../../android/app/build.gradle.kts) введён единый
`okhttpVersion = "4.12.1"`. Его используют `okhttp`, тестовый `mockwebserver` и
`okhttp-tls`. Runtime и HTTPS fixtures остаются на одной patch-версии;
перехода на OkHttp 5.x нет. Получение этих трёх артефактов и фактическое
исполнение HTTPS тестов на новом наборе подтвердит итоговый Android CI.

## Совместимость и оставшиеся границы проверки

| Компонент | Подтверждение или ограничение |
|---|---|
| AGP 8.13.2, JDK 17, compile/target SDK 36 | [Официальные требования AGP](https://developer.android.com/build/releases/agp-8-13-0-release-notes) указывают минимум Gradle 8.13, JDK 17 и поддержку API до 36.1. Gradle 8.14.7 удовлетворяет этому минимуму; успешность полного приложения на точном новом наборе ещё проверяется. |
| Kotlin/KGP 2.2.21 | [Матрица JetBrains](https://kotlinlang.org/docs/gradle-configure-project.html) указывает Gradle 7.6.3–8.14 и полностью поддерживаемый AGP 7.3.1–8.11.1. Текущий AGP 8.13.2 выше этой границы. JetBrains допускает более новые версии с возможными предупреждениями и ограничениями; прежний успешный CI не расширяет официальную матрицу. |
| Compose compiler 2.2.21 и KSP 2.2.21-2.0.4 | Compiler plugin имеет ту же версию, что Kotlin; [официальный KSP release](https://github.com/google/ksp/releases/tag/2.2.21-2.0.4) прямо указывает Kotlin 2.2.21. |
| Room 2.8.5 | Это текущий stable из [официальных release notes](https://developer.android.com/jetpack/androidx/releases/room), выпущенный 9 сентября 2026 года. |
| Сопровождение Kotlin 2.2.21 | [Политика JetBrains](https://github.com/JetBrains/kotlin/security) обещает security updates compiler/build plugins последней language/tooling release. Новое 18-месячное окно JVM stdlib начинается с 2.4.0; на 2.2.21 оно здесь не переносится. Применимый новый Kotlin CVE в этом аудите не установлен. |

Проверены объявленные build/runtime зависимости и релевантные первичные
release/security источники по состоянию на дату отчёта. Другого подтверждённого
применимого security advisory для объявленных AndroidX и Coroutines в этой
конечной проверке не найдено. Возраст версии сам по себе не выдаётся за известную
уязвимость; массовое обновление AGP, Kotlin или Compose в этот patch не входит.

Полный разрешённый транзитивный граф/SBOM не сканировался, поэтому отчёт не
заявляет «ноль уязвимостей Android». Он не удостоверяет обновлённость системных
Android/WebView на пользовательских устройствах, физический ARM64, production
signing или работу live API/SMTP. Исторические receipts сохранены. Для допуска
нового APK требуется отдельный результат CI, привязанный к итоговому commit
с Gradle 8.14.7, OkHttp 4.12.1 и всеми текущими исходниками приложения.
