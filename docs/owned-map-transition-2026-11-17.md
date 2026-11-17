# Тропиныч: переход на собственную инфраструктуру карты

## Статус и границы доказательства

**Перенос не завершён.** Этот документ фиксирует проверенные исходники,
лицензии и условия перехода. Он не подтверждает развёртывание tile service,
получение полного покрытия России или выпуск production APK.

Source baseline: [`ecf672bff60983e764fcaa9a3d5b44f834b1f6d6`](https://github.com/orewn/tropnik/commit/ecf672bff60983e764fcaa9a3d5b44f834b1f6d6).
Основной аудит выполнен на `b8ac705c9a13d96fc4716aef746c7938ecc5c2a1`;
между ним и baseline нет изменений проверенных provider inputs:
`custom-map-tiles.ts`, `custom-map-landscape.ts`, `map-satellite.ts`,
`map-preload.ts`, `map-transport.ts`, `map-resource-pool.ts`,
`web/package.json`, `android/app/build.gradle.kts`,
`CustomMapResourcePolicy.kt` и `maps/online-sources.json`.
Официальные условия источников проверены 17 ноября 2026 года.

Первая проверка baseline в
[Pages 44071007674](https://github.com/orewn/tropnik/actions/runs/44071007674)
остановилась на desktop `map-pan`: frame P95 = 35.1 ms при неизменном
лимите 35 ms. До полного мобильного browser audit этот запуск не дошёл.
Публикация кандидата этим запуском не подтверждена; результаты прошлой
версии не заменяют его приёмку.

## Что означает «перенести к нам»

| Уровень | Цель | Состояние |
| --- | --- | --- |
| Код и оформление | Движок, выбор данных, стиль и интерфейс контролируются проектом | Собственный Canvas/MVT runtime уже используется. В проверенных web/Android зависимостях активного стороннего map SDK нет. |
| Хранение и доставка | Выпущенное приложение получает карту, снимки и высоты с нашей инфраструктуры и из локальных пакетов | Только часть данных локальна. Онлайн-карта обращается к OpenFreeMap, Mapterhorn и EOX. VPS Тропиныча не развёрнут и доступ к нему не подтверждён. |
| Исходная база и права | Понятно, кто создал данные, что разрешено и какие уведомления обязательны | OSM, Copernicus, ESA, NASA и шрифты остаются данными/работами их авторов. Собственный сервер и собственная обработка не делают их исходники нашей исключительной собственностью. |

Открытые лицензии позволяют отказаться от закрытого SDK и платной
лицензии картографического провайдера, сохранив обязательные кредиты.
Удаление лицензий или переименование внешних данных не является переносом.

## Инвентаризация компонентов

Пути относительно корня репозитория. «Локально» означает наличие и доставку
конкретных файлов, а не покрытие всей страны. Источники S1–S15 приведены ниже.

| Компонент и source evidence | Runtime host | Лицензия/права | Что уже у нас | Что ещё переносить |
| --- | --- | --- | --- | --- |
| Движок и стиль: `web/lib/custom-map-engine.ts`, `custom-map-vector.ts`, `custom-map-painter.ts` | Собственные web assets; Android packaged assets | Реализация проекта. Использование формата MVT не равно использованию SDK Mapbox. | Canvas renderer, декодер и painter; общий runtime web/Android | Движок переносить со стороннего SDK уже не требуется. |
| Векторная подложка: `web/lib/custom-map-tiles.ts`, `map-preload.ts`, Android `maps/online-sources.json` | `tiles.openfreemap.org` | OpenFreeMap code MIT; OpenMapTiles code BSD-3-Clause, schema/design CC BY 4.0; OSM data ODbL. Кредиты и условия данных сохраняются. [S1], [S2], [S3] | Ограниченный offline pilot | Онлайн-данные нужного охвата, сейчас TileJSON `/planet/latest`, native z14; получить официальный archive/extract и отдавать прежний PBF со своего сервиса. |
| Terrain онлайн: `custom-map-tiles.ts`, `custom-map-landscape.ts` | `tiles.mapterhorn.com` | Mapterhorn code BSD-3-Clause; лицензии данных отдельные. Для используемого Copernicus GLO-30 — бесплатное воспроизведение, распространение и изменение с обязательными уведомлениями. [S4], [S5] | Пилотная DEM и локальные региональные grids | Terrarium WEBP512, текущий native z12: перенести из официального PMTiles либо независимо подготовить из GLO-30 COG, сохранив качество и metadata. |
| Спутник: `web/lib/map-satellite.ts` | `tiles.maps.eox.at`, `s2cloudless_3857` | **Текущий 2016 vintage — CC BY 4.0, коммерческая встроенная подложка разрешена.** Использует Sentinel 2016/17. EOX 2018+ в текущей конфигурации отсутствует. [S6], [S7] | Собственный renderer, обработка ошибок и выбор слоя; исходные снимки внешние | Полный самостоятельный pipeline открытых снимков либо подтверждённый канал получения именно текущего dataset. App-specific cache не устраняет upstream dependency. |
| Спутниковый fallback: `map-satellite.ts`, `docs/satellite-map.md` | `tiles.maps.eox.at`, `bluemarble_3857` | NASA Earth Observatory / Blue Marble, доставка EOX. Общие NASA условия допускают factual reuse с кредитом и без endorsement; конкретный исходный vintage EOX полностью не установлен. [S8], [S9] | Собственный выбор fallback для известного проблемного района 180° | Определить точный NASA source product, воспроизвести/проверить покрытие и свою доставку. Нельзя объявлять неизвестный EOX source «500 m» по общему описанию Blue Marble. |
| Overview relief: `web/public/maps/russia-relief/manifest.json` | Локальный `/maps/russia-relief/` | Natural Earth SR_50M v2.0.0 — public domain. OSM/geoBoundaries mask имеет собственные условия. [S10], [S3] | Растры z0–4 и окраска проекта | Уже локален. Исторический shaded-relief raster1:50M не является численной DEM и не заменяет GLO-30. |
| Маршруты и границы: `data/catalog/DATA_LICENSE.txt`, `web/public/data/russia-boundaries-provenance.json`, imported geometries | Локальные data assets | Конкретная граница имеет provenance ODbL-1.0, OSM/Wambacher через geoBoundaries; OSM routes также сохраняют свои условия. [S3] | Локальные геометрии, обработка, каталог | Поддерживать обновление и provenance. Не приписывать этим boundary files CC BY только по названию агрегатора geoBoundaries. |
| Региональные 3D: `web/public/terrain-regions/south-sakhalin-v1/`, `south-sakhalin-central-v1/`, `tools/terrain-data/build_region.py` | Локальные assets; исходные COG читаются при подготовке | GLO-30 open licence + ESA WorldCover 2021 v200 CC BY 4.0. [S5], [S11] | Два ограниченных окна: DEM около 30 m, land-cover classes около 10 m, palette проекта | Расширять только с реальными данными. Изображение классов покрытия — не спутниковое фото и не измеренные отдельные деревья. |
| Offline pilot: `web/public/offline-map/manifest.json`, `data/pilot-map`, Android `maps/pilot`, `maps/terrain-pilot` | Локально | Упакованные notices OpenMapTiles/OpenFreeMap/Noto и DEM | 193 vector tiles z7–14 в bbox `[40.29,43.64,40.49,43.82]`; web package6,887,834 bytes | Это конечная пилотная область, не offline Россия. Спутник не входит. Android receipt отдельно подтверждает фактически упакованный subset, без vendor glyphs. |
| Manrope и Noto: `web/public/fonts/`, `data/pilot-map/licenses/`, Android fonts/licenses | Локальные web/Android assets | SIL OFL1.1. [S12], [S13] | Шрифты self-hosted/packaged; `@fontsource/manrope`5.3.0 — build dependency | Покупка/замена не нужна. Сохранять notices и условия изменённых fonts. В проверенных UI sources нет remote Google Fonts/Typekit requests. |

### SDK и пакеты: фактическая граница аудита

В `web/package.json` и `android/app/build.gradle.kts` нет прямых зависимостей
Mapbox, MapLibre, Leaflet или Protomaps renderer. Публикация собственного
runtime проверяется в `tools/pages-preview/custom-map-assets.mjs`,
`web/scripts/verify-custom-map.mjs` и
`tools/android-build/prepare-custom-map.mjs`: vendor runtime inputs запрещены.
Оставшиеся исторические LICENSE файлы MapLibre/Leaflet/Protomaps не доказывают
их активное использование; удалять notices в рамках этого аудита не требуется.

Native [inventory](verification/mobile-b8ac705-android/android-dependency-release-audit.json) из анализа
[Android b8ac705 / 44004885737](https://github.com/orewn/tropnik/actions/runs/44004885737)
фиксирует открытые AndroidX/Compose/Room, Kotlin/coroutines и OkHttp;
native map использует platform WebView, location — platform LocationManager.
Это декларативный source audit, **не полный resolved/transitive SBOM**.
Владение приложением не означает владение реализацией ОС/WebView.
Перед заявлением о полной проверке каждой зависимости нужен versioned
inventory resolved компонентов и обязательных notices выпущенного бинарника.

## Спутник: что именно заменять

EOX FAQ разделяет бесплатный коммерческий 2016 слой и 2018+ слои с
non-commercial либо платными коммерческими условиями. Текущий код уже
фиксирует 2016. Бесплатный endpoint не имеет SLA, может ограничивать трафик;
FAQ рекомендует кэш приложения на CDN/устройстве, но отдельно оговаривает
standalone raw redistribution. Это service/access условия, которые нельзя
пересказывать как запрет распространения в самом тексте CC BY. Полный
bulk mirror нельзя считать готовым или безусловно разрешённым лишь из
доступности публичного z/x/y URL. [S6], [S7]

Для полной независимости от EOX есть проверенный открытый кандидат:
**ESA WorldCover Sentinel-1 and Sentinel-2 10m Annual Composites**.
Лицензия именно этой imagery collection, а не только land-cover map,
подтверждена отдельной официальной [записью AWS Open Data][S16]
и её [source YAML][S17], управляемыми VITO:

- `License: CC-BY 4.0`, `RequesterPays: False`;
- Sentinel-2 RGBNIR median composite содержит B02/B03/B04/B08;
- годы 2020/2021, COG, сетка 1°×1°, около 10 m;
- официальный public bucket `s3://esa-worldcover-s2`, доступ без AWS account;
- [официальный индекс продуктов][S18] содержит пути к нужным COG;
- обновления коллекции не заявлены. Годовая медиана не является свежим
  оперативным снимком.

Легальный bulk путь — получить выбранные реальные COG через опубликованный
bucket/индекс, сохранить metadata, notices и provenance, затем изготовить
RGB-подложку и свою пирамиду. WMS-картинка и 11-классовая WorldCover карта
не подменяют исходный RGBNIR. Альтернативно можно собирать свой composite
из Sentinel-2 L2A; [Sentinel Legal Notice][S14] разрешает распространение и
изменение с указанием происхождения. Условия содержимого сайта Copernicus
нельзя переносить на сам dataset. [S15]

Около 10 m — номинальная пространственная детализация, **не обещание
идентичного визуального качества EOX**. Цвет, сезон, облачность, снег,
nodata, точность мозаики и доступность Арктики/180° проверяются на реальных
пикселях. Существующий EOX fallback z8 значительно грубее слоя z14;
его замена должна улучшать или сохранять фактическое покрытие, а не
скрывать пустоты. Отрицательные результаты прежних GIBS/WMS попыток
записаны в `docs/satellite-map.md`; повторная смена URL без проверки
не является решением.

## Последовательность переноса

1. **Подтвердить инфраструктуру и границы охвата.** Собственный домен,
   storage, tile service, TLS/CORS, мониторинг и budget; затем реальный
   каталог доступных регионов. Не оценивать размер России по глобальному
   размеру архива и не скачивать весь public tile endpoint.
2. **Перенести vector/DEM с сохранением payload.** OpenFreeMap публикует
   archives для self-hosting; Mapterhorn документирует PMTiles extracts и
   `--dry-run`. [S1], [S4] На первом этапе сохранять исходные PBF/schema и
   Terrarium WEBP512, native z14/z12. PMTiles может быть серверным
   контейнером, без нового клиентского SDK. Pin версии и coverage.
3. **Подготовить открытый imagery pipeline.** Выбранные WorldCover RGBNIR
   либо Sentinel L2A → documented nodata/cloud/color policy → COG/tiles
   → свой storage и endpoint. Сохранить resolution, source years и
   реальные provenance records; не выдавать overzoom за новые детали.
4. **Переключить источники после gate ниже.** Точки изменения:
   `custom-map-tiles.ts`, `map-preload.ts`, `map-satellite.ts`,
   `map-transport.ts`, `map-resource-pool.ts`, CSP custom-map HTML,
   Android `CustomMapResourcePolicy.kt` и `maps/online-sources.json`.
   Обновить manifests/credits и штатно пересобрать общий runtime.
   Сейчас allowlists привязаны к трём внешним hostnames; одной замены
   URL недостаточно.
5. **Поддерживать данные независимо.** Версионирование, обновления,
   проверка целостности и удаление неполных выпусков. Runtime не должен
   молча возвращаться на старые внешние providers. Build-time получение
   открытых исходников остаётся отдельной документированной зависимостью.

Если отдельная цель — отказаться также от OpenMapTiles schema/design,
возможен будущий независимый MVT schema/pipeline непосредственно из OSM.
Это реальная переработка ETL, семантики слоёв и renderer, а не переименование
текущих tiles. До подтверждения независимого результата текущие OpenMapTiles
credits остаются; ODbL права/обязанности на OSM data сохраняются и после него.

## Обязательный gate переключения

Переход можно объявить завершённым только после фактических receipts,
привязанных к исходникам и установленным/опубликованным байтам.
Выбор dataset, наличие config и успешная сборка этого не подтверждают.

| Gate | Необходимое доказательство | Текущий статус |
| --- | --- | --- |
| Данные и права | Реальные полученные объекты/архивы, версия, источник, лицензионные notices, checksum manifest; отдельно права imagery collection | Лицензии исследованы; полного собственного dataset нужного охвата нет |
| Coverage | Реальные source bounds/tile inventory, nodata mask и контроль берегов, гор, Арктики, обеих сторон 180°; честная обработка отсутствующих данных | Для нового полного набора не получено |
| Детализация | Vector features/schema не потеряны; DEM samples,512px encoding, datum/nodata сохранены; снимки проверены в native resolution. Новая сетка/overzoom не засчитывается как дополнительное измерение | На новых self-hosted данных не проверено |
| Визуальное качество | Сравнимые кадры одинаковых реальных сцен и масштаба: линии, текст, фото, вода/стыки, cloud/snow/nodata. Все существующие pixel/render gates сохранены | Для нового источника receipts отсутствуют |
| Сеть и независимость | Настоящий web network и Android broker receipt: map/terrain/satellite/pan/zoom используют только одобренные собственные endpoints/local assets; **ноль** запросов к трём прежним runtime hosts и никаких скрытых fallback к ним | Текущий APK receipt перечисляет все три внешних host |
| Runtime и UX | Прежние geometry/hit/gesture/performance/offline thresholds проходят на новом источнике; loading/error/отсутствующая зона остаются реальными состояниями | Текущая мобильная приёмка ещё отдельная незавершённая работа |
| Публикация | Доступный собственный HTTPS endpoint, exact deployed build/data manifest и проверка на выпущенном Android/Web; заявленный offline coverage соответствует пакету | Собственное развёртывание не подтверждено |

## Что сейчас блокирует production, помимо карты

Эти ограничения не устраняются изменением лицензий или упаковкой tiles.
Положительный unsigned build и preview release — разные доказательства.

| Блок | Конкретное подтверждение состояния | Что должно закрыть блок |
| --- | --- | --- |
| Владелец production signing key | `production-verification.json`, [Android 44004885737][R1], source `b8ac705`: `kind=unsigned-production-build-check`, `signatureVerified=false`, `signingCertificateSha256=null`, `productionPublished=false`; APK 61,058,625 bytes, SHA-256 `dca99c406e9baa50cecd0671c1282ad97b2a5c3180a68462e757e9e0159469e1` | Внешний owner-managed keystore, обе password env, non-debug alias и независимо зафиксированный SHA-256 сертификата; signed exact candidate. Контракт: `tools/android-build/verify-production.py`, `build-release.sh`, `android/app/build.gradle.kts`. Секреты не хранятся в репозитории. |
| Реальный API/DB/SMTP | Тот же receipt: `liveApiVerified=false`; production preflight требует HTTPS `TROPA_API_BASE_URL`. Self-host CI из [исторического отчёта](continuation-2026-11-17.md) имел пустой API origin | Развёрнутые Next/Go/PostgreSQL/PostGIS и реальные readiness/auth/data/SMTP receipts. `infra/production/tropinych/README.md` — configuration/runbook, не deploy proof. |
| Доступ и развёртывание VPS | 17 ноября 2026, 11:09 UTC: обычный SSH завершился exit255 с `Bad owner or permissions on /etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf`. Вход и серверные команды не выполнялись, обход не применялся. Предыдущее HTTP наблюдение фиксирует на целевом VPS ДокНет | Разрешённый рабочий доступ, проверка существующих сервисов и реальное развёртывание без их нарушения; HTTPS/readiness/данные должны быть проверены снаружи. Сейчас Тропиныч на VPS не подтверждён. |
| Совместимое обновление | Текущий production receipt: `upgradeVerified=false`. [Публичный 0.4.34 proof](verification/android-0.4.34-public.json) фиксирует mismatch сертификата с 0.4.33; это описано в [checkpoint](continuation-2026-11-17.md) | Подтверждённая signing identity и upgrade exact APK с сохранением пользовательских данных. Удаление установленного приложения не заменяет проверку обновления. |
| Финальное устройство и новый UI | Production receipt: `deviceExecutionVerified=false`. Native audit для b8ac705:12/13 device cases passed, compact font 200 overflow failed. ecf672b остановился на `adb pull` установленного test APK до запуска instrumentation: 0/13 сценариев начато, полнота installed bytes не подтверждена. [Receipt](verification/mobile-ecf672b-android/native-findings.json). Прежние CI — x86_64 emulator/SwiftShader, не физический ARM64 | Успешные обязательные сценарии текущего exact APK и отдельная проверка физического ARM64/GPS/GPU/батареи там, где такие свойства заявляются. |

Точный [unsigned receipt](verification/mobile-b8ac705-android/production-verification.json)
и связанный [native inventory](verification/mobile-b8ac705-android/android-dependency-release-audit.json)
сохранены в репозитории побайтно. Их поля и CI run выше отделены от
публичной приёмки 0.4.34 и не названы production release proof.

## Официальные источники

- [S1 — OpenFreeMap][S1]: self-hosting archives, открытый code и bounded
  offline policy. [Terms][S1t] отдельно ограничивают public endpoint:
  до 3000tiles или 50MB, до 4parallel, идентифицируемый User-Agent.
- [S2 — OpenMapTiles code/schema/design licence][S2].
- [S3 — OpenStreetMap copyright и ODbL][S3].
- [S4 — Mapterhorn data access][S4], [attribution][S4a] и [code/dataset summary][S4h].
- [S5 — Copernicus WorldDEM-30 licence][S5].
- [S6 — EOX2016/2018+, endpoint/cache/attribution FAQ][S6].
- [S7 — CC BY4 legalcode][S7].
- [S8 — EOX::Maps sources and service conditions][S8].
- [S9 — NASA images/media conditions][S9].
- [S10 — Natural Earth public-domain terms][S10].
- [S11 — ESA WorldCover data access][S11].
- [S12 — Manrope OFL][S12]; [S13 — Noto OFL][S13]. Local copyright notices
  относятся к упакованной версии, их нельзя автоматически заменить
  строкой из нового upstream.
- [S14 — Copernicus Sentinel Legal Notice][S14]; [S15 — portal terms][S15].
- [S16 — отдельный AWS registry для annual imagery composites][S16];
  [S17 — registry source YAML с license и public bucket][S17];
  [S18 — официальный grid/index composites][S18].

[S1]: https://openfreemap.org/
[S1t]: https://openfreemap.org/tos/
[S2]: https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md
[S3]: https://www.openstreetmap.org/copyright
[S4]: https://mapterhorn.com/data-access/
[S4a]: https://mapterhorn.com/attribution/
[S4h]: https://mapterhorn.com/
[S5]: https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM/resources/license/License-COPDEM-30.pdf
[S6]: https://cloudless.eox.at/documentation/faq
[S7]: https://creativecommons.org/licenses/by/4.0/legalcode.en
[S8]: https://maps.eox.at/
[S9]: https://www.nasa.gov/nasa-brand-center/images-and-media/
[S10]: https://www.naturalearthdata.com/about/terms-of-use/
[S11]: https://esa-worldcover.org/en/data-access
[S12]: https://github.com/google/fonts/blob/main/ofl/manrope/OFL.txt
[S13]: https://github.com/google/fonts/blob/main/ofl/notosans/OFL.txt
[S14]: https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice
[S15]: https://dataspace.copernicus.eu/terms-and-conditions
[S16]: https://registry.opendata.aws/esa-worldcover-vito-composites/
[S17]: https://github.com/awslabs/open-data-registry/blob/main/datasets/esa-worldcover-vito-composites.yaml
[S18]: https://esa-worldcover.s3.eu-central-1.amazonaws.com/esa_worldcover_grid_composites.fgb
[R1]: https://github.com/orewn/tropnik/actions/runs/44004885737
