# Публичная тестовая версия Тропника

Целевой адрес: **https://orewn.github.io/tropnik/**. Посетителю не требуется аккаунт ChatGPT или GitHub.

Workflow [pages.yml](../.github/workflows/pages.yml) собирает сайт из исходников `main` при каждом push и при ручном `workflow_dispatch`. Он не использует приватный Site или файлы из аккаунта владельца. Каталог `dist` создаётся в runner из выбранного commit; отдельная ветка с вручную изменённой сборкой не нужна.

## Что публикуется

- Статический клиент с картой, территориями, справочным каталогом, отдельной объёмной сценой и управлением пилотным офлайн-пакетом.
- Все страницы и ресурсы с префиксом **`/tropnik/`**, включая прямые ссылки, Service Worker и автономный просмотрщик `/tropnik/offline-viewer.html`.
- ARM64 APK **0.4.2-preview, versionCode 6** по адресу [tropnik-arm64-preview.apk](https://orewn.github.io/tropnik/downloads/tropnik-arm64-preview.apk).
- Проверочные файлы `build-info.json`, `page-manifest.json`, `verification.json`, `http-verification.json`, версии и хеши входных данных.

Социальный API в статическом адаптере недоступен: вход, регистрация, чаты и серверные изменения не имитируются и не отправляют запросы. Для этих функций требуется отдельное развёртывание Go/PostGIS. Офлайн-пакет и объёмная сцена сохраняют область пилотного района; публикация не расширяет их покрытие.

## Неизменённые Android-файлы

Веб-сборка не пересобирает Android. Она использует уже проверенный ARM64 APK с размером и SHA256, закреплёнными в [android-manifest.json](../web/public/downloads/android-manifest.json).

| Файл | Размер в байтах | SHA256 |
|---|---:|---|
| `tropnik-arm64-preview.apk` | 24 467 090 | `41eabb299c0b2037311e813dd8d15f1f026977f601d851dfdd537b48b2f32292` |
| `tropnik-preview.apk` | 31 619 028 | `775bcfea9ca1ac775876f9fc419f4c67a222b25d59f4962a5aa23d7e1b33becd` |

Оба файла относятся к Android **0.4.2-preview** и имеют отладочную подпись. Совпадение хеша не заменяет испытание приложения на устройстве. Universal APK доступен отдельно в release и не увеличивает каждую сборку сайта.

Для первой публикации точные существующие файлы нужно добавить как assets к [релизу v0.4.2-preview](https://github.com/orewn/tropnik/releases/tag/v0.4.2-preview), сохранив имена. Получатся публичные адреса:

- [ARM64 APK](https://github.com/orewn/tropnik/releases/download/v0.4.2-preview/tropnik-arm64-preview.apk).
- [Universal APK](https://github.com/orewn/tropnik/releases/download/v0.4.2-preview/tropnik-preview.apk).

`fetch-apk.mjs` сначала проверяет локальный ARM64 файл. Если его нет, инструмент получает файл из release без Authorization, проверяет размер и SHA256 до атомарного переименования. При HTTP-ошибке, неправильном содержимом или превышении размера сборка прекращается. Ссылка на приватное хранилище, заглушка или автоматическая новая сборка APK не используются как замена.

## Условия запуска

В настройках репозитория **Settings → Pages → Build and deployment → Source** должен быть выбран **GitHub Actions**. Workflow не меняет видимость репозитория и не включает Pages административным токеном. Окружение `github-pages` должно разрешать деплой `main`. На других ветках и в другом репозитории этот workflow не публикует сайт.

Это официальный способ публикации собственного статического генератора: [настройка источника](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) и [custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Последовательность проверок

1. Checkout точного commit события, без сохранения Git credentials.
2. Node.js 24, `pnpm@11.25.0`, установка по `pnpm-lock.yaml` с `--frozen-lockfile`. Политика зависимостей из `web/pnpm-workspace.yaml` сохраняется.
3. Получение и проверка неизменённого APK, отрицательные проверки загрузчика, веб-регрессии и TypeScript статического адаптера.
4. Сверка настроенного origin `https://orewn.github.io` и base path `/tropnik`. Неожиданная настройка останавливает публикацию.
5. Сборка `tools/pages-preview/build.mjs`. Внутри обязательны проверки реального скомпилированного router, недоступности статического API, ресурсов, SHA256 географии и офлайн-пакета, локальные HTTP-проверки и ZIP.
6. Загрузка только `web/pages-preview/dist` через `upload-pages-artifact`; скрытые `.nojekyll` и `.vite` сохраняются. Исходники приложения, окружение runner и node_modules в artifact не включаются.
7. Отдельный deploy job после успешной сборки, с `pages: write`, `id-token: write` и окружением `github-pages`.
8. Проверка публичного сайта без авторизации: точные build ID и source commit, главная и её JS/CSS, прямые страницы, автономный просмотрщик, территория и полный хеш скачанного APK. Краткая задержка CDN допускает ограниченный повтор проверки версии. Иная версия не объявляется текущей.

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
