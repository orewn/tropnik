# Тропиныч.рф: конфигурация production

Канонический адрес — **https://тропиныч.рф/**. Его точная ASCII-форма:
`https://xn--h1akbedl4b5a.xn--p1ai`. `www` перенаправляется на основной домен
с сохранением пути и строки запроса. Целевой VPS — `5.35.84.81`.

На VPS запускаются Next, Go API и PostgreSQL/PostGIS через существующие
`compose.yaml` и `compose.web.yaml`. Caddy на хосте принимает HTTPS.
REG остаётся провайдером DNS; статическая выгрузка GitHub Pages не заменяет
Next и его серверный обработчик сессий. Файлы в этом каталоге — заготовка
конфигурации, а не подтверждение выполненного развёртывания.

## 1. Подготовить и запустить приложение

Нужен Linux x86-64 с Docker Compose и установленным host Caddy. Команды ниже
выполняются из каталога `infra` в копии репозитория на VPS. Для новой установки:

```bash
umask 077
cp -n production/tropinych/env.example .env
chmod 600 .env
```

Заполните четыре обязательных пустых секрета независимыми значениями, сохранив
права файла `0600`. Инструкция генерации и правила резервного копирования —
в [основном руководстве](../../README.md#configure-and-start). При обновлении
существующей установки сохраните её пароли, ключи и том базы данных.

`PUBLIC_ORIGIN` должен оставаться в ASCII-форме **без завершающего `/`**.
Compose передаёт его в Next и Go, а также в сборку Next как `SITE_ORIGIN`.
Индексация включена через `TROPA_PUBLIC_INDEXING=true`. Изменение домена или
режима индексации требует пересборки web, а не только перезапуска контейнера.

```bash
docker compose -f compose.yaml -f compose.web.yaml --env-file .env config --quiet
docker compose -f compose.yaml -f compose.web.yaml --env-file .env build
docker compose -f compose.yaml -f compose.web.yaml --env-file .env up -d
docker compose -f compose.yaml -f compose.web.yaml --env-file .env ps
curl --fail --silent --show-error http://127.0.0.1:8080/api/v1/health/ready
curl --fail --silent --show-error http://127.0.0.1:3000/api/status
```

Обе проверки должны вернуть HTTP 200; `/api/status` должен сообщить
`configured: true`, `connected: true`, `mode: "connected"`. Миграция должна
завершиться с кодом 0, а долгоживущие сервисы — быть healthy. Только после
этого переходите к переключению домена.

## 2. Подключить Caddy и DNS

Добавьте два блока из [Caddyfile](Caddyfile) в конфигурацию host Caddy,
сохранив конфигурацию других сайтов. Проверьте итоговый файл и перезагрузите
уже установленный и работающий сервис:

```bash
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
```

При включении пары `TRUSTED_PROXY_CIDRS` / `TROPA_PROXY_TOKEN` укажите реальные
адреса ingress и Next, которые видит Go, и передайте тот же токен в окружение
**host Caddy**. `--env-file .env` настраивает Compose, но не systemd-сервис.
Без этой пары приложение не доверяет заголовкам адреса клиента; бюджеты по IP
могут объединяться по адресу прокси. Подробности — в [руководстве ingress](../../ingress/README.md).

После готовности runtime установите следующие записи в личном кабинете
**REG.RU**, в управлении DNS домена. Зона делегирована на `ns1.reg.ru` и
`ns2.reg.ru`; доступ к FTP или пароль ISPmanager не заменяют доступ к этому
разделу личного кабинета.

| Имя | Тип | Значение |
| --- | --- | --- |
| `@` | `A` | `5.35.84.81` |
| `www` | `A` | `5.35.84.81` |

Оставьте существующие NS `ns1.reg.ru` и `ns2.reg.ru`. Не добавляйте AAAA без
проверенного IPv6 на VPS. При проверке 14.11.2026 наблюдались TTL
21600–86400 секунд. По этим значениям старые DNS-ответы могут сохраняться в
кэшах до 24 часов; это не гарантированный срок обновления у всех клиентов.
Публичные TCP-порты 80 и 443
должны вести к host Caddy; порты приложения 3000 и 8080 остаются loopback.
Caddy завершит выпуск сертификатов после того, как проверки обоих доменных
имён достигнут VPS. Перезагрузка Caddy сама по себе не подтверждает готовность HTTPS.

## 3. Проверить публичный адрес

После обновления DNS и выпуска сертификатов:

```bash
curl --fail --silent --show-error https://xn--h1akbedl4b5a.xn--p1ai/api/status
curl --fail --silent --show-error https://xn--h1akbedl4b5a.xn--p1ai/api/v1/health/ready
curl --fail --silent --show-error https://xn--h1akbedl4b5a.xn--p1ai/robots.txt
curl --fail --silent --show-error https://xn--h1akbedl4b5a.xn--p1ai/sitemap.xml
curl --silent --show-error --head 'https://www.xn--h1akbedl4b5a.xn--p1ai/routes/?region=test'
```

Ожидаются connected-статус, HTTP 200 у readiness, разрешение публичных страниц
в robots и адрес sitemap на основном домене. В sitemap и HTML canonical/OG
должен быть только `https://xn--h1akbedl4b5a.xn--p1ai`, без старого домена и
префикса `/tropnik/`. Последняя команда должна вернуть 308 и
`Location: https://xn--h1akbedl4b5a.xn--p1ai/routes/?region=test`.
В браузере проверьте карту, быстрое отдаление, каталог и переходы по маршрутам.

## Почта — отдельное включение

Шаблон оставляет SMTP и action URL пустыми: новая регистрация и запросы новых
почтовых ссылок закрыты. Когда будет настроен реальный отправитель, заполните
все нужные mail-поля и задайте
`TROPA_ACCOUNT_ACTION_URL=https://xn--h1akbedl4b5a.xn--p1ai/account/action/`.
Для URL писем тоже нужна ASCII-форма домена. Непустой action URL с неполной
SMTP-конфигурацией не является рабочим режимом.

Следуйте [инструкции почты](../../README.md#optional-account-mail) и добавьте
`-f compose.mail.yaml` к тем же командам Compose. Используйте независимый
стабильный `TROPA_ACCOUNT_MAIL_KEY`; не удаляйте его при наличии ранее
зашифрованных заданий. Этот preset не создаёт SMTP-аккаунт или пользователя приложения.
