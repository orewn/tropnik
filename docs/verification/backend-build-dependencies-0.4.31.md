# Backend и инструменты данных 0.4.31 — ограниченная проверка зависимостей

Дата проверки: **13 ноября 2026 года**. Проверены объявленные Go-модули,
текущие Go/build pins, age, четыре файла Python requirements и фактические
версии PostgreSQL/PostGIS в последнем успешном recovery drill. Это проверка
конечного списка зависимостей по первичным release/security источникам.
Полный SBOM, транзитивные библиотеки образов и все возможные уязвимости проекта
этим отчётом не покрываются.

Подтверждены три необходимых изменения или открытых условия:

| Компонент | Состояние при аудите | Результат |
|---|---|---|
| Go toolchain | Успешный main CI использовал 1.27.3 | Активные build/CI/module требования изменены на **1.27.4**. Новый CI с этими pins ещё ожидается. |
| Pillow для terrain tooling | `Pillow>=11,<13` исключал исправленную версию | Требование изменено на **`Pillow==13.0.0`**. Две существующие проверки сохранённых terrain assets прошли на этой версии. |
| PostgreSQL/PostGIS image | Recovery drill фактически использовал PostgreSQL **18.6**, PostGIS **3.7.0** | **18.7 содержит новые security fixes.** Исправленный совместимый образ и его повторный native/recovery gate на момент этого аудита ещё не подтверждены. |

## Go: обновление toolchain без изменения модулей

[Официальная история Go](https://go.dev/doc/devel/release#go1.27.4) фиксирует
выпуск **1.27.4 от 10 ноября 2026 года** с исправлениями безопасности в cgo,
командах сборки, compiler/linker и `net/http`. Переход с 1.27.3 требуется
по опубликованным исправлениям, а не из-за возраста номера версии.

Два проверенных первичных advisory показывают разные границы применимости:

| Проблема | Условие | Что установлено для проекта |
|---|---|---|
| [CVE-2026-97054, Go issue 82563](https://go.dev/issue/82563) | HTTP/1 handler одновременно читает body через `MaxBytesReader` и пишет response headers; превышение лимита может вызвать гонку и аварийное завершение. | API использует `MaxBytesReader(1 MiB)`. В проверенном middleware обработчик вызывается синхронно; сам по себе этот вызов не доказывает необходимую конкурентность. Эксплуатация в приложении не воспроизводилась. |
| [CVE-2026-97040, Go issue 82570](https://go.dev/issue/82570) | Сборка специально подготовленного `.syso` допускает внедрение linker/cgo metadata; затрагивается и путь pure-Go builds. | `CGO_ENABLED=0` не является общим освобождением от security fixes toolchain. Злонамеренный `.syso` или компрометация зависимостей в репозитории не обнаружены. |

Минимальный patch меняет `backend/go.mod`, `backend/Dockerfile` и
`.github/workflows/backend.yml` на Go **1.27.4**. Версии модулей и `go.sum`
в этом patch не меняются. Перечисленные два advisory — проверенные примеры
применимости, а не полный перечень исправлений данного Go release.

### Объявленные модули

Источник inventory: [go.mod](../../backend/go.mod) и [go.sum](../../backend/go.sum).

| Модуль | Объявленная версия | Результат ограниченной проверки |
|---|---|---|
| `github.com/jackc/pgx/v5` | `v5.12.0` | Уже содержит исправления двух октябрьских advisories, приведённых ниже. |
| `golang.org/x/sync` | `v0.24.0` | Дополнительный применимый опубликованный advisory в проверенных первичных источниках не установлен. Новая версия сама по себе не является основанием для изменения. |
| `golang.org/x/text` | `v0.43.0` | Выше исправленной `v0.39.0` для [GO-2026-5970 / CVE-2026-56852](https://pkg.go.dev/vuln/GO-2026-5970): некорректный UTF-8 мог приводить к бесконечному циклу Unicode normalization. |
| `github.com/jackc/pgpassfile` — indirect | `v1.0.0` | Новый обязательный security patch в этой конечной проверке не установлен. |
| `github.com/jackc/pgservicefile` — indirect | `v0.0.0-20240606120523-5a60cdf6a761` | Новый обязательный security patch в этой конечной проверке не установлен. |
| `github.com/jackc/puddle/v2` — indirect | `v2.2.3` | Новый обязательный security patch в этой конечной проверке не установлен. |

Проверенные advisories pgx опубликованы **31 октября 2026 года**:

| Advisory | Затронутые версии v5 / первая исправленная | Условие |
|---|---|---|
| [GHSA-j38q-h3ph-jjpq](https://github.com/jackc/pgx/security/advisories/GHSA-j38q-h3ph-jjpq) | `>=5.0.0, <5.12.0` / `5.12.0` | `SendBatch` в simple protocol, запрос заканчивается `--` без перевода строки, следующий содержит управляемый атакующим строковый параметр. Extended protocol этим advisory не затронут. |
| [GHSA-95fj-3fxw-g62g](https://github.com/jackc/pgx/security/advisories/GHSA-95fj-3fxw-g62g) | `>=5.9.0, <5.12.0` / `5.12.0` | Подставной сервер пропускает `AuthenticationOk`, обходя требования `require_auth`/`channel_binding`. Текущий pin уже исправлен. |

Также текущий pgx выше первых исправлений `5.9.2` для
[GHSA-j88v-2chj-qfwx](https://github.com/jackc/pgx/security/advisories/GHSA-j88v-2chj-qfwx)
и `5.9.0` для protocol decoder advisories
[GO-2026-4771](https://pkg.go.dev/vuln/GO-2026-4771) и
[GO-2026-4772](https://pkg.go.dev/vuln/GO-2026-4772).

Поиск по [базе Go Security Team](https://pkg.go.dev/vuln/) и первичным
maintainer advisories не заменяет анализ достижимости символов.
`govulncheck` в рамках этой проверки **не запускался**.
Старые записи только с суффиксом `/go.mod` в `go.sum`, включая тестовые
зависимости, не считаются доказательством включения их кода в серверный binary.

## age для encrypted backup

Workflow получает **age 1.3.2** и проверяет SHA-256 архива Linux amd64:
`cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10`.
Последний recovery receipt также сообщает фактически исполненный `age v1.3.2`.

Первичный [GHSA-32gq-x56h-299c](https://github.com/FiloSottile/age/security/advisories/GHSA-32gq-x56h-299c)
затрагивает версии **до 1.2.1**: управляемое атакующим имя plugin в recipient
или identity может приводить к запуску binary через path separator.
Исправление начинается с **1.2.1**, поэтому текущий pin 1.3.2 не требует
изменения по этому advisory. Транзитивный состав готового age binary отдельно
не сканировался.

## Python-инструменты данных: Pillow 13.0.0

В [terrain requirements](../../tools/terrain-data/requirements.txt) заменено
только `Pillow>=11,<13` на `Pillow==13.0.0`. Прежний диапазон исключал версию,
исправляющую оба найденных advisory:

| Первичный advisory | Затронутые версии / исправление | Условие и последствие |
|---|---|---|
| [GHSA-wqgw-9xfh-qf2g](https://github.com/python-pillow/Pillow/security/advisories/GHSA-wqgw-9xfh-qf2g), 2026-11-02 | `<=12.3.0` / `13.0.0` | Перекрывающиеся TIFF/EXIF tag data могут вызвать чрезмерное выделение памяти при разборе небольшого изображения. |
| [GHSA-78g4-xqwv-q3g8](https://github.com/python-pillow/Pillow/security/advisories/GHSA-78g4-xqwv-q3g8), 2026-10-17 | Wheels `11.1.0–12.3.0` / `13.0.0` | Встроенный OpenJPEG содержит heap-buffer-overflow write, достижимый через декодирование изображения; обновление только системной библиотеки не исправляет bundled copy. |

Это зависимости локального terrain tooling. `verify_region.py` открывает
surface/classes через Pillow; `recolor_region.py` также декодирует classes.
Само расширение имени файла не ограничивает декодер Pillow. При этом проверяемые
assets имеют provenance/checksums, а публичный backend image-upload путь с
Pillow в проекте не установлен. Эти Python-зависимости не включаются в APK.

### Фактически выполненная проверка

Среда: **Python 3.12.14, Pillow 13.0.0, NumPy 2.3.5**.
Существующие проверки выполнены **2026-11-13 в 08:22:24 UTC**:

```sh
python tools/terrain-data/verify_region.py south-sakhalin-v1
python tools/terrain-data/verify_region.py south-sakhalin-central-v1
```

| Регион | Результат | Grid / material | Grid bytes / material bytes |
|---|---|---|---|
| `south-sakhalin-v1` | exit 0 | `660×632` / `1977×1894` | `2748100` / `317687` |
| `south-sakhalin-central-v1` | exit 0 | `660×632` / `1977×1894` | `2719554` / `358748` |

Проверки читают имеющиеся grid, surface, classes и provenance; проверяют
checksums, границы/ориентацию сетки, конечность данных, palette/classes и
ограничения range-загрузок. Новые тесты не добавлялись, assets не перезаписывались.
Полное построение из исходных raster datasets и сетевой pipeline rasterio
здесь не исполнялись.

Остальные объявления сохранены:

| Файл | Объявленные зависимости |
|---|---|
| `tools/terrain-data/requirements.txt` | `numpy>=2.0,<3`, `Pillow==13.0.0`, `rasterio>=1.4,<2` |
| `tools/android-build/requirements.txt` | `numpy==2.3.5`, `Pillow==13.0.0` |
| `tools/map-package/requirements-territories.txt` | `numpy==2.3.5`, `shapely==2.1.2`, `osmium==4.3.2` |
| `tools/import-data/requirements.txt` | `shapely>=2.0,<3.0` |

Дополнительный применимый advisory, требующий изменения этих NumPy/Shapely/
osmium/rasterio объявлений, в конечном поиске не установлен. Это не утверждение
о безопасности всех разрешённых диапазоном версий. У NumPy и Rasterio на
проверенных maintainer security страницах нет опубликованных advisories;
полнота индексации Shapely/pyosmium не подтверждена. [Политика Rasterio](https://github.com/rasterio/rasterio/security)
отдельно предупреждает о платформозависимых bundled GDAL и других C-библиотеках.
Их точный состав и уязвимости, равно как GEOS/libosmium, здесь не проверены.

## PostgreSQL: успешный recovery ещё не подтверждает новый security release

[Main CI 43391174999](https://github.com/orewn/tropnik/actions/runs/43391174999)
и [его receipt](backend-0.4.31-main.json) относятся к commit
`baf0b9ef8b8132711a317e861cf1d8aed68800fb`, tree
`d8a036565054c9f28a372e21578d3fbb9e0d10f5`.
На Go **1.27.3** прошли 8 пакетов unit/race tests, `go vet`, **54** top-level
native tests (**85** с subtests, без FAIL/SKIP), schema **8**, **32** таблицы,
**16** guards и **11** отрицательных recovery cases. Это сохранённое
историческое доказательство; оно не переносится на новый toolchain/image.

Исходный `backup-restore.json`, проверенный в `2026-11-13T08:12:45.088658+00:00`,
имеет SHA-256 `00fb074d60aecec9d74135b4634e7b46c5611b2364d153cdc2eaefe2d54a8686`:

| Поле | Фактическое значение |
|---|---|
| PostgreSQL | `18.6 (Debian 18.6-1.pgdg13+2)` |
| PostGIS | `3.7.0` |
| Docker image ID | `sha256:26355bcc80a42bc38c96ca2a7d7fda6ce08d5cd5b4546c4800b1695356c74a85` |

Image ID — идентификатор локального Docker image, **не** registry multiarch
manifest digest. Объявленный `postgis/postgis:18-3.7` является изменяемым tag;
само его имя не доказывает PostgreSQL 18.7.

[PostgreSQL 18.7 выпущен 12 ноября 2026 года](https://www.postgresql.org/docs/release/18.7/).
Два подтверждённых примера исправлений применимы к версии 18.6, но имеют разные
prerequisites:

| Advisory | Условие | Граница применимости |
|---|---|---|
| [CVE-2026-116322](https://www.postgresql.org/support/security/CVE-2026-116322/) | Только ветка 18 до 18.7: unauthenticated network client может вызвать restart через гонку cancel request с `authentication_timeout`. | Ограничения SQL-роли сами по себе этот сценарий не устраняют. В текущем compose порт БД не опубликован, сеть `backend` internal; публичная достижимость не установлена. |
| [CVE-2026-6460](https://www.postgresql.org/support/security/CVE-2026-6460/) | Object creator может вызвать type confusion через DDL и исполнение кода от OS-пользователя PostgreSQL. В ветке 18 исправлено в 18.7. | Обычная API-роль отделена от owner/migrations; HTTP-пользователь не получает произвольный SQL. Эксплуатация через приложение не доказана, но версия сервера затронута. |

Release notes 18.7 требуют **пересборки C-language extensions для полной защиты**
от composite type mismatch; некоторым extensions нужны изменения исходников.
Поэтому обновление только PostgreSQL binary в прежнем образе нельзя считать
достаточным подтверждением исправления PostGIS deployment. Нужны проверяемое
происхождение совместимого образа, фактические версии и native/recovery gate
на его точных bytes. В этом отчёте такого нового результата пока нет.

Live backend/SMTP и действующая пользовательская PostgreSQL-база этим аудитом
не развёртывались. Он не удостоверяет security state чужого или будущего
deployment. `govulncheck`, `pip-audit`, container CVE scan и полный resolved
dependency graph/SBOM не запускались; заявления «ноль уязвимостей проекта» нет.
