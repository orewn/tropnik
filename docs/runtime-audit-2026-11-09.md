# Аудит обработчиков и исполнения: 9 ноября 2026

## Область и уровень доказательств

Основание — жалобы на задержки карты, неработающие нажатия и потерянные правки, с отдельным требованием проверить ПК. Исходный срез аудита: `5a78f6fcce0eca9f125944a746ddd23e9b66876d`. Описанные ниже исправления относятся к текущему рабочему diff. Этот документ **не является подтверждением публикации**, успешного Android CI или развёртывания backend.

Проверялись веб-карта в двух движках, конструктор, истории, панели, меню, модальные окна, сохранение карточек, фоновые подписки, связанные нативные изменения и границы серверной интеграции. Статический обзор и Node-тесты не заменяют нажатия в браузере, Kotlin-компиляцию или запуск на телефоне. Исторические требования перечислены отдельно в `docs/ui-requirements-audit-2026-11-09.md`; прежние PASS не переносятся автоматически на новый commit.

В проекте нет отдельной фермы устройств или стенда распределённой высокой нагрузки. Есть workflows GitHub Actions и контейнерный интеграционный стенд PostgreSQL/PostGIS: `.github/workflows/{pages,android,backend}.yml`, `infra/compose.test.yaml`, `infra/run-integration.sh`. Наличие этих файлов означает наличие сценариев проверки, а не факт их успешного исполнения сейчас.

## Ведомость web

| Модуль | Подтверждённая причина или риск | Исправление / текущая граница | Источники |
| --- | --- | --- | --- |
| Leaflet: попадание по карте | Отдельный интерактивный Canvas в `trail-points` на z-index 650 закрывал DOM-маркеры регионов на 600 и территориальный Canvas на 400. `clearLayers()` оставлял сам Canvas, поэтому возврат к направлениям не убирал перехват. | Маршруты и территории используют общий интерактивный renderer; расширена область попадания, задан приоритет точек/линии. Поведенческие проверки работают с настоящим Leaflet Canvas. Финальная проверка реальных экранов выполняется отдельно. | `web/components/Atlas2D.tsx`, `web/tests/atlas-canvas-interactions.test.mjs`, `web/app/map-ui-release.css` |
| WebGL: обработка попаданий | Раздельные обработчики перекрывающихся слоёв могли конкурировать; старый zoom-gate запрещал территориальный клик после увеличения. | В рабочем diff используется общий выбор по реально отрисованным слоям с приоритетом маршрута. Desktop wheel/drag/клики нужно проверять на самом MapLibre, не по наличию строки обработчика. | `web/components/Atlas.tsx`, `web/lib/map-interaction.ts` |
| Кластер направлений | На узком экране fit всех членов большого кластера мог воспроизводить тот же обзор: нажатие выглядело бесполезным. | Добавлено правило прогресса масштаба `directionExpansionZoom`. Подтверждение, что конкретные телефонные/ПК сценарии раскрывают направления, относится к отдельному runtime-прогону. | `web/lib/map-config.ts`, `web/lib/map-direction-layout.ts`, `web/components/Atlas.tsx`, `web/components/Atlas2D.tsx` |
| Подписи и resize | DOM collision layout уже был ограничен `moveend`/`zoomend`, а не каждым `move`. При этом `ResizeObserver` удерживал удалённые карточки/сообщения; поздний `fonts.ready` мог снова поставить RAF после cleanup. | Исчезнувшие элементы снимаются с наблюдения и удаляются из Set; dispose блокирует очередь и уже извлечённые callbacks. Общий RAF scheduler ограничивает новые частые обработчики одним ожидающим кадром. | `web/lib/map-direction-layout.ts`, `web/lib/map-interaction.ts`, `web/tests/map-label-lifecycle.test.mjs`, `web/tests/map-interaction.test.mjs` |
| Атрибуция | В первые пять секунд `pointerdown` по самой ссылке атрибуции всплывал в карту и удалял ссылку до её `click`. | Собственные элементы атрибуции исключены из auto-collapse; взаимодействие с ними отменяет таймер, а следующий жест по карте всё ещё работает. Cleanup снимает оба обработчика и таймер. | `web/components/MapAttribution.tsx`, `web/lib/map-attribution.ts`, `web/tests/map-attribution.test.mjs` |
| Конструктор: ввод текста и дней | `mapPoints` зависел от всего `draft`; буква названия/заметки или смена дня заставляли Leaflet удалить и создать все маркеры. Callback выбора также зависел от массива этапов. | Введена стабильная идентичность геометрического пути; текст и дни не меняют `pathOptions`/маркеры. Выбор точки обновляет актуальный draft функционально и отвергает точку от уже заменённой тропы. | `web/components/HikePlanner.tsx`, `web/lib/hike-draft.ts`, `web/tests/hike-draft.test.mjs` |
| Конструктор: расчёт геометрии | При каждом новом старте/финише/via повторно нормализовались и fingerprint-проверялись все исходные координаты. Dijkstra оказался значительно дешевле. | Один приватный immutable snapshot готовится на загрузку/повторную загрузку; изменения пути используют проверенные части. Raw-resolver продолжает проверять данные при каждом вызове. Проверки digest/fingerprint не отключены. | `web/lib/trail-connections.ts`, `web/components/HikePlanner.tsx`, `web/tests/trail-connections.test.mjs` |
| Сохранённые карточки | Чтение считало `request.success` завершением транзакции; соединение закрывалось только при успехе. Удаление не слушало `tx.abort` и могло оставить Promise незавершённым. Inline-геометрия не переносилась в отдельное поле пакета. | Все операции ждут commit, отклоняются при abort/error/синхронной ошибке и закрывают БД в `finally`. Сохраняется `trail.geometry`; загрузка URL используется при её отсутствии. `as any` в разборе ответа заменён проверкой unknown-обёртки. Имя БД и формат пакета сохранены. | `web/lib/local.ts`, `web/tests/local-packs.test.mjs` |
| Service Worker | Долгоживущая registration сохраняла anonymous `updatefound` и `statechange` после размонтирования компонента. | Регистрация и устанавливаемые workers имеют явное владение подписками; terminal state/unmount снимает обработчики. Поздний результат `register()` не подключается к уже закрытому компоненту. | `web/components/ServiceWorker.tsx`, `web/lib/service-worker-registration.ts`, `web/tests/service-worker-registration.test.mjs` |
| Геолокация | Старый асинхронный ответ мог сместить камеру после более нового выбора маршрута/жеста. | В текущих изменениях добавлена отмена по generation/взаимодействию. Реальные permission/error/повторные нажатия проверяются отдельно от unit-теста диспетчера. | `web/components/Atlas.tsx`, `web/components/Atlas2D.tsx` |
| Настройки и типы карты | Пороги масштаба, размеры попадания и лимиты ресурсов были разбросаны по движкам; planner импортировал типы из компонента карты. | Общие значения и типы вынесены в отдельные модули. Это упрощает согласование, но само по себе не доказывает плавность или совпадение поведения SDK. | `web/lib/map-config.ts`, `web/lib/map-types.ts`, `web/lib/map-preload.ts`, `web/lib/map-resource-pool.ts` |
| Истории, меню, модальные окна, 3D | В проверенных историях нет тяжёлого `pointermove`; события, интервалы и IntersectionObserver имеют cleanup. Header/Modal управляют фокусом. TerrainRenderer объединяет draw в RAF и освобождает controls/resize. | Нового подтверждённого постоянного цикла или массового повторного подписывания здесь не найдено. Это ограниченный обзор кода; аппаратные FPS, скринридер и все устройства им не покрыты. | `web/components/{PlaceStories,Header,Modal,TerrainScene}.tsx`, `web/public/terrain/terrain-renderer.js` |

### Измерение конструктора на настоящем крупном маршруте

Использован `osm-relation-18162201`, начало `@0`, конец `@1449`: **61 185** исходных вершин, **1 380** выбранных refs, **35 088** точек результата и **1 107 169,513 м** по выбранным рёбрам. Это измерение чистых функций в Node 24.22.1, без DOM, тайлов, GPU и телефона.

| Операция | Median | p95 | Интерпретация |
| --- | ---: | ---: | --- |
| Исходный `resolvePlanGeometry` | 83,250 мс | 102,604 мс | Повторная полная обработка при смене точки |
| `resolvePreparedPlanGeometry` после изменений | 7,706 мс | 18,393 мс | Примерно в 10,8 раза меньше median в этом локальном измерении |
| Подготовка snapshot после изменений | 26,720 мс | 28,360 мс | Один раз на новую загрузку, а не на каждое изменение пути |

Число точек и дистанция этого плана не изменились. Числовое сравнение координат сохраняет эквивалентность ±180° и ±0; граф пересобран в режиме `--check` без изменения JSON. Измерение не означает обещание конкретного FPS. Первичная загрузка/JSON parse, отрисовка длинной линии SDK и фактические реакции DOM требуют отдельного профилирования.

Snapshot хранится приватно через WeakMap, содержит собственные замороженные координаты и не использует изменяемый raw GeoJSON как доверенный ключ. Возвращаемые точки отделены от snapshot. Новая загрузка или retry создаёт новый snapshot; stale digest, изменённый fingerprint, отсутствующие части и поддельный snapshot блокируются. Тесты также меняют исходный объект и ранее возвращённый результат, проверяя отсутствие отравления следующих расчётов.

### Граница имеющихся browser checks

В исходном `tools/pages-preview/browser-smoke.mjs` были только четыре coarse-профиля: 320×640, 390×844, 412×915 и 844×390, с обязательным Leaflet. Проверялись sheet, истории, геометрия контролов и Layers. Desktop MapLibre, wheel/drag, ввод в planner и полный сценарий выбор → сохранение → GPX таким набором не доказывались. Старый порог long task в 350 мс проверялся в ветке истории и не обнаруживал задержку конструктора в 80–100 мс.

`web/tests/ui-smoothness.test.mjs` и часть старых UI gates проверяют структуру исходников. Их PASS означает сохранение wiring/условий, а не физическую кликабельность всех элементов. Отдельный runtime-прогон должен зафиксировать движок, тип указателя, действие, ожидаемый результат и фактический commit. Публикация и успешный общий CI до этого в документе не отмечаются.

## Android: проверенное изменение и остатки

| Модуль | Статус текущего кода | Что ещё не подтверждено / не реализовано | Источники |
| --- | --- | --- | --- |
| Подготовка линии | JSON и четыре camera extrema готовятся на `Dispatchers.Default`; SDK-вызовы остаются на Main. Возвращается тот же исходный String, без упрощения или соединения частей. | Отмена старого эффекта предотвращает commit его результата, но CPU parse сам не имеет частых cooperative cancellation checkpoints. Замеров на физическом телефоне нет. | `android/app/src/main/java/ru/tropa/app/{ui/TropaMap.kt,data/MapRouteGeometry.kt}`, `android/app/src/test/java/ru/tropa/app/data/MapRouteGeometryTest.kt` |
| Новая геометрия с тем же id | Ключ `LaunchedEffect` теперь включает `apiRevisionId`, `geometryAsset` и `inlineGeometry`; изменённый источник повторно устанавливается в map source. Хеширование большой строки при кадрах не добавлено. | Это исправление триггера эффекта; оно не является исполненным тестом Kotlin/Compose на устройстве. | `android/app/src/main/java/ru/tropa/app/ui/TropaMap.kt`, `tools/android-build/test_tropa_map_threading.py` |
| Нажатия на карте | Новый instrumentation-сценарий находит MapView, ждёт стиль, проецирует настоящий маркер и вводит `MotionEvent.ACTION_DOWN/UP` через UiAutomation. | Он покрывает маркер региона. Полигон региона и линия маршрута в native click listener по-прежнему не подключены. | `android/app/src/androidTest/java/ru/tropa/app/LocalExperienceTest.kt`, `android/app/src/main/java/ru/tropa/app/ui/TropaMap.kt` |
| Долгота и камера | Сохранена прежняя min/max трактовка. | Трек от −179° до +179° получает диапазон 358°, а не короткое окно через антимеридиан. Новый unit fixture явно описывает сохранение прежнего поведения; это не PASS исправления dateline. | `android/app/src/main/java/ru/tropa/app/data/MapRouteGeometry.kt`, `android/app/src/test/java/ru/tropa/app/data/MapRouteGeometryTest.kt`, `android/app/src/main/java/ru/tropa/app/data/RussiaDisplayArea.kt` |
| JVM JSON и сборка | `testImplementation("org.json:json:20250517")` указан явно, assets path передаётся unit-тестам. Явного отсутствующего JSON runtime в Gradle-конфигурации не найдено. | В этой рабочей сессии Gradle, JVM unit tests и device suite локально не выполнялись: SDK/adb отсутствуют. Нужен фактический Android CI нового commit. | `android/app/build.gradle.kts`, `.github/workflows/android.yml` |
| Жизненный цикл аккаунта | Native показывает `emailVerified` и обычные вход/профиль. | Native UI/API client не подключает запрос/подтверждение email, запрос/сброс пароля и удаление аккаунта, хотя серверные endpoints существуют. | `android/app/src/main/java/ru/tropa/app/data/ApiClient.kt`, `android/app/src/main/java/ru/tropa/app/OnlineViewModel.kt`, `android/app/src/main/java/ru/tropa/app/ui/OnlineScreens.kt` |

Локальный `test_tropa_map_threading.py`: **4/4 PASS** после изменения ключа. Это source-level gate размещения dispatcher и зависимостей, а не замена JVM, ART, GPU или permission-flow тестирования. Старые APK, изображения и отчёты из `docs/verification` не доказывают новый исходный код.

## Backend и внешние интеграции

| Контур | Доказательство в репозитории | Реальная граница |
| --- | --- | --- |
| Go API, PostgreSQL/PostGIS | `backend/internal/httpapi`, `backend/internal/store`, `backend/migrations`; unit/integration tests; `.github/workflows/backend.yml` запускает race/vet и `infra/run-integration.sh`. | **Go локально в этой сессии не исполнялся.** Существование тестов/YAML не является новым PASS. В текущем публичном выпуске backend/PostGIS не развёрнуты; нового live deployment proof нет. Настройка и проверка реального API остаются отдельной работой. |
| Email lifecycle | `backend/internal/httpapi/account_lifecycle.go`, `backend/internal/auth/account_lifecycle_mail.go`, `backend/cmd/tropa-api/account_lifecycle_config.go`. | Требуются настоящий TLS SMTP, отправитель, action URL и проверка доставки. Без SMTP регистрация/новые action links закрываются явно. `cfg == nil` возвращает объект lifecycle без mail-контура, а не nil panic. |
| Рассылка и очередь | В `account_lifecycle.go` ограничены in-memory slots/jobs и число mail workers; сохранён audit результата. | При перезапуске процесса ожидающая память теряется; это не гарантированная доставка и не распределённая очередь. Ответ о принятии запроса не подтверждает доставку письма. |
| Чаты, группы, отзывы, роли | `backend/internal/store/{social,recruitment,moderation,guides}.go`, `backend/internal/httpapi`, веб-BFF/API client. | Нет нового сквозного proof публичный web ↔ backend ↔ native, доставки SMTP и конкурентного сценария нескольких клиентов на актуальном deploy. Статические Pages не выполняют серверный код. |
| Safety/МЧС | `docs/SAFETY-REGISTRATION.md`, `web/components/SafetyRegistration.tsx`. | Текущая форма — локальный паспорт/экспорт и переход к официальной подаче. Это не серверная регистрация похода, подтверждение приёма МЧС или действующая rescue-интеграция. |

Backend не изменялся в рамках описанной оптимизации ввода и карты. Ранее сохранённые цифры Go-тестов и PostGIS-отчётов относятся к своим исходным срезам. Они не используются здесь как доказательство новой сборки или высокой нагрузки.

## Шаблонный код, зависимости и не подключённые функции

В отдельном аудите зависимостей выявлены неиспользуемые шаблонные UI-компоненты и прямые зависимости; их очистку ведёт отдельный исполнитель. Найденный `reInit` без парного `off` в старом `ui/carousel.tsx` не объявлен причиной задержки карты: внешнего использования компонента не обнаружено. Итоги удаления и установки зависимостей относятся к отдельному install/audit/build gate.

`zod` нельзя считать лишним только по отсутствию импорта в видимых страницах: его используют `web/scripts/connector-preview` и `web/lib/connector-errors.mts`. `connector-error → button` был единственным внешним ребром к проверенному набору шаблонных UI-компонентов. Удаление библиотек не доказывает производительность и не заменяет повторную сборку всех реально используемых входов.

Не подключённые native polygon/line clicks и account lifecycle перечислены выше как функциональные остатки. Платежи/marketplace не добавлялись и не считаются утраченными правками данного некоммерческого объёма.

## Исполненные локальные проверки этого аудита

| Проверка | Наблюдаемый результат | Ограничение |
| --- | --- | --- |
| Core/draft/attribution focused suite | 36/36 PASS | Node behavioral tests; не браузер |
| Lifecycle/storage/layout focused suite | 39/39 PASS, включая вложенные storage cases | Отдельный прогон; числа пересекающихся suites не складывать |
| Full web TypeScript | exit 0 | Проверка типов на рабочем срезе до финального общего freeze |
| Pages TypeScript | exit 0 | Не static build/deploy |
| Generated graph `--check` | 306 карточек, 277 геометрий, 29 без геометрии; 1 014 связей: 672 shared / 281 intersection / 61 nearby; 950 629 байт; JSON не изменён | Не подтверждает проходимость или доступ |
| Source digest графа | `4bc53c0cea87a67d6288994679e03b52b5ed427a0c0cdcc3c1f7ec83b3dfcdad` | Привязка исходных геометрий, не build/deployment receipt |
| Native source threading/key gate | 4/4 PASS | Не Gradle/JVM/device |
| Targeted `git diff --check` | Без whitespace-ошибок в файлах данного исправления | Общий freeze и release проверяются отдельно |

Дальнейшее подтверждение выпуска требует общего web-прогона после всех параллельных правок, статической и Worker-сборки, desktop/mobile действий в каждом применяемом движке и Android CI на точном исходном commit. До получения соответствующих результатов данный документ не отмечает их выполненными.
