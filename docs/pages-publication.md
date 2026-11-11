# Публичная тестовая версия Тропника

Целевой адрес: **https://orewn.github.io/tropnik/**. Посетителю не требуется аккаунт ChatGPT или GitHub.

Workflow [pages.yml](../.github/workflows/pages.yml) собирает сайт из исходников `main` при изменениях продукта и при ручном `workflow_dispatch`; изменения только документации исключены. Он не использует приватный Site или файлы из аккаунта владельца. Каталог `dist` создаётся в runner из выбранного commit; отдельная ветка с вручную изменённой сборкой не нужна.

## Что публикуется

- Статический клиент с собственным движком карты, территориями, справочным каталогом, объёмным просмотром выбранного участка и управлением пилотным офлайн-пакетом.
- Все страницы и ресурсы с префиксом **`/tropnik/`**, включая прямые ссылки, Service Worker и автономный просмотрщик `/tropnik/offline-viewer.html`.
- Ссылка на проверенный universal APK из версионного GitHub Release. Версия, три ABI, размер, SHA256, исходный commit и доказательство установленных байтов закреплены в [android-manifest.json](../web/public/downloads/android-manifest.json).
- Проверочные файлы `build-info.json`, `page-manifest.json`, `verification.json`, `http-verification.json`, `browser-verification.json`, `browser-terrain-mask-verification.json`, `browser-terrain-full-mask-verification.json`, `browser-terrain-presentation-verification.json`, `browser-map-underlay-verification.json`, отчёт геометрии attribution, версии и хеши входных данных.

Социальный API в статическом адаптере недоступен: вход, регистрация, чаты и серверные изменения не имитируются и не отправляют запросы. Для этих функций требуется отдельное развёртывание Go/PostGIS. Подробный офлайн-пакет и автономная 3D-сцена сохраняют область пилотного района. Онлайн-просмотр веб-карты использует данные выбранного участка и действующую маску территории; наличие нового справочного маршрута само по себе не расширяет офлайн-покрытие.

## Проверенная Android-поставка

Веб-сборка не пересобирает Android. Она использует точный universal APK, который собран Android workflow и установлен в его device job. Полное тело файла проверяется без авторизации по размеру и SHA256. APK хранится в GitHub Release и не включается в каждый Pages artifact.

`fetch-apk.mjs` сначала проверяет локальный файл выбранной архитектуры. Если его нет, инструмент получает версионный release asset без Authorization, проверяет размер и SHA256 до атомарного переименования. Существующий локальный файл с другим хешем не перезаписывается; для смены версии используется чистый рабочий каталог. HTTP-ошибка, неправильное содержимое или превышение размера останавливают сборку.

APK имеет development/debug подпись. Device receipt описывает эмулятор x86_64, фактические установленные байты и число выполненных сценариев. Он не является проверкой физического ARM64, полевой навигации или готовности к публикации в магазине.

### Продвижение следующей версии

1. Полный кандидат проходит web, настоящий browser gate и Android device gate до слияния.
2. Изменение `release-request.json` в `main` запускает сборку, восемь device-сценариев и publisher. Publisher отказывается перезаписывать ранее выпущенные байты или тег с другим происхождением.
3. После успешной публикации проверяются release metadata, checksum-файл, `preview-build.json`, `device-result.json` и публичные байты universal APK. Общий release-манифест описывает ARM64; его нельзя просто копировать в universal-манифест сайта.
4. Манифест сайта формируется из этих доказательств для `tropnik-preview.apk` и отдельно обновляется в `main`. Android `sourceCommit` остаётся SHA проверенного APK, даже когда Pages собирается из более позднего коммита ссылки.
5. Pages заново проходит браузерную матрицу и подтверждает публичную выдачу нового манифеста и APK.

Пока новый Android release не проверен, сайт сохраняет ссылку предыдущего выпуска. Политика publisher запрещает перезапись; она сама по себе не означает, что в настройках GitHub включена функция Immutable Releases.

## Условия запуска

В настройках репозитория **Settings → Pages → Build and deployment → Source** должен быть выбран **GitHub Actions**. Workflow не меняет видимость репозитория и не включает Pages административным токеном. Окружение `github-pages` должно разрешать деплой `main`. На других ветках и в другом репозитории этот workflow не публикует сайт.

Это официальный способ публикации собственного статического генератора: [настройка источника](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) и [custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Последовательность проверок

1. Checkout точного commit события, без сохранения Git credentials.
2. Node.js 24, `pnpm@11.25.0`, установка по `pnpm-lock.yaml` с `--frozen-lockfile`. Политика зависимостей из `web/pnpm-workspace.yaml` сохраняется.
3. Получение и проверка неизменённого APK, отрицательные проверки загрузчика, веб-регрессии и TypeScript статического адаптера.
4. Сверка настроенного origin `https://orewn.github.io` и base path `/tropnik`. Неожиданная настройка останавливает публикацию.
5. Сборка `tools/pages-preview/build.mjs`. Внутри обязательны проверки реального скомпилированного router, недоступности статического API, ресурсов, SHA256 географии и офлайн-пакета, локальные HTTP-проверки и ZIP.
6. Настоящий Chromium pixel gate проверяет маску, отверстия и широкую линию в WebGL2/Canvas, исходном и изменённом ракурсе, а также восстановление графического контекста. Отчёт закрепляет SHA renderer.
7. Полная браузерная матрица проверяет пять размеров экрана, реальные вводы, карту и спутник, 3D, офлайн-сценарии и прежние бюджеты плавности. Отчёты обязаны принадлежать точному commit. Диагностический job со статусом success не заменяет обязательную приёмку.
8. Загрузка только проверенного `web/pages-preview/dist` через `upload-pages-artifact`; скрытые `.nojekyll` и `.vite` сохраняются. Исходники приложения, окружение runner и node_modules в artifact не включаются.
9. Отдельный deploy job после успешной сборки, с `pages: write`, `id-token: write` и окружением `github-pages`.
10. Проверка публичного сайта без авторизации: точные build ID и source commit, browser report, главная и её JS/CSS, прямые страницы, автономный просмотрщик, территория и полный хеш скачанного APK. Краткая задержка CDN допускает ограниченный повтор проверки версии. Иная версия не объявляется текущей.

Браузерные проверки используют один профиль: программную композицию страницы и SwiftShader для WebGL. CDP до загрузки приложения фиксирует фактические Chrome/GPU/CPU/OS, параметры запуска и размеры клиентского окна; его физическая область обязана вмещать все пять исходных viewport/DPR. Уменьшенное native-окно не может получить полный PASS. Пиксельный отчёт встроен в полный browser report и сверяется с отдельно сохранённым оригиналом; проверки реальных кнопок и шрифтов в горизонтальном режиме также связаны с той же средой и commit. [Причина и контролируемое сравнение](verification/custom-engine-browser-environment.json).

Деплой использует один и тот же загруженный artifact. Параллельная публикация сериализована группой `github-pages`; выполняющийся deploy не обрывается следующим push. Ошибка загрузки исходников, проверок или APK останавливает работу до публикации. Ошибка публичной HTTP-проверки после deploy помечает workflow как неуспешный и требует проверки адреса; она не выдаётся за успешную приёмку.

## Закреплённые Actions

Теги и commit SHA сверены с официальными GitHub API refs **6 ноября 2026 года**. Workflow использует полный SHA, а не изменяемый major-тег. `action.yml` выбранных версий прочитан для проверки входов и выходов.

| Action | Выпуск | Commit SHA | Официальная ссылка |
|---|---|---|---|
| `actions/checkout` | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` | [tag ref](https://api.github.com/repos/actions/checkout/git/ref/tags/v7.0.1) |
| `actions/setup-node` | v7.1.0 | `949feb2413d6458794dcd2491c4babbbce0c15c1` | [tag ref](https://api.github.com/repos/actions/setup-node/git/ref/tags/v7.1.0) |
| `actions/configure-pages` | v6.0.0 | `45bfe0192ca1faeb007ade9deae92b16b8254a0d` | [tag ref](https://api.github.com/repos/actions/configure-pages/git/ref/tags/v6.0.0) |
| `actions/upload-pages-artifact` | v5.0.0 | `fc324d3547104276b827a68afc52ff2a11cc49c9` | [tag ref](https://api.github.com/repos/actions/upload-pages-artifact/git/ref/tags/v5.0.0) |
| `actions/deploy-pages` | v5.0.1 | `368f82528645a54fb793d4d04e342629a3f51346` | [tag ref](https://api.github.com/repos/actions/deploy-pages/git/ref/tags/v5.0.1) |

## Локальная сборка

После установки зависимостей команды выполняются из корня проекта:

```sh
node tools/pages-preview/fetch-apk.mjs
node --test tools/pages-preview/tests/*.test.mjs
node web/node_modules/typescript/bin/tsc -p web/pages-preview/tsconfig.json --noEmit
node tools/pages-preview/build.mjs --base /tropnik/ --origin https://orewn.github.io
```

Результат: `web/pages-preview/dist` и `web/pages-preview/tropnik.zip`. Обычная локальная сборка хранит `sourceCommit: null`; в Actions это полный commit проверенного checkout из `GITHUB_SHA`. Первичные SHA256 входов присутствуют в обоих случаях.

Публичный smoke-check после Actions можно повторить с build ID и commit из нужного workflow:

```sh
node tools/pages-preview/verify-deployed.mjs https://orewn.github.io/tropnik/ BUILD_ID SOURCE_COMMIT
```

Локальный build, зелёный download test и наличие workflow не доказывают внешний деплой. Для результата нужны успешные build/deploy jobs и проверка публичного адреса. HTTP-проверки не измеряют GPU/FPS и не заменяют просмотр браузером или запуск Android на устройстве.

## Подготовка объединённого кандидата

Отдельный workflow подготовки может пересоздать производные ресурсы на изолированной ветке `prepare/final-site-0.4.24`. Он закрепляет исходный commit, разрешает изменения только в перечисленных выходах генераторов и создаёт новый commit только из этих выходов. Эта подготовка не публикует сайт и не заменяет проверки выпуска. Полные браузерные и Android jobs заново проверяют исходники и производные ресурсы конечного commit в режиме `--check`.

Допуск 3D требует пять снимков: исходный ракурс, оба предельных масштаба, поворот и сброс. Перед единственной попыткой захвата проверяется ожидаемый завершённый ракурс без ожидающего GPU-кадра и без незавершённого появления интерфейса; сразу после захвата, до записи файлов, повторно проверяется та же идентичность кадра. Смена кадра во время захвата завершает проверку ошибкой. Ограниченное ожидание готовности учитывается отдельно и не сбрасывает непрерывные счётчики долгих задач или сдвигов интерфейса. Все прежние вводы, интервалы и пороги производительности сохранены.
