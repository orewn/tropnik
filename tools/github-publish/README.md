# Локальный план прямой публикации исходников через Git Database API

Инструмент только читает указанный source snapshot и пишет локальные инвентаризации или JSON payloads. Сетевых обращений, GitHub mutations, изменения refs и изменения исходного snapshot в нём нет. Отправку API запросов выполняет владелец публикации через подключённый GitHub инструмент.

## Инвентаризация

```sh
python3 tools/github-publish/inventory.py inventory \
  --source /workspace/scratch/a2ce00e514d4/tropnik-github-merged-final/source/tropnik \
  --parent 7ddf2da8fac7f51c1ea3e6b37d0583eacaf81d59 \
  --out tools/github-publish/generated/inventory.json
```

Если уже получен полный Git Trees API ответ родительского дерева, передайте `--known-blobs parent-tree.json`. Допустим также JSON массив известных blob SHA из подтверждённых API receipts. Эти объекты исключаются из upload плана. Обрезанный `truncated: true` tree response отклоняется. Наличие в таком списке означает только утверждение предоставившего его инструмента; этот локальный скрипт не проверяет GitHub.

Файлы дедуплицируются по **Git blob SHA-1**, вычисленному над `blob <byte-length>\0` и точными исходными байтами. Это не обычный SHA-1 файла. SHA-256 дополнительно сохраняется для контроля исходного snapshot. UTF-8 текст сохраняет переводы строк и остальные исходные байты; данные с NUL, управляющими байтами или невалидным UTF-8 считаются binary. Повторяющиеся пути с одинаковым blob требуют одну загрузку.

Из publish set исключены raw/cache/build каталоги, зависимости, release APK/архивы, машинные настройки, credential files и обнаруженные явные маркеры ключей или токенов. Это ограниченная проверка известных признаков, а не сертификат отсутствия секретов. Причины и относительные пути исключения перечислены без содержимого. Нормализованный каталог, проверяемые GeoJSON, тайлы, DEM, лицензии и необходимые шрифты сохраняются. Gradle wrapper JAR остаётся обычным читаемым файлом с Git mode `100644`; исполняемые исходные скрипты сохраняют `100755`.

### Приватные выгрузки и регрессия границы

Любой каталог `private/`, файлы с полными суффиксами `*.export.json` и `*.queue.json` исключаются до чтения содержимого. Это относится к JSON-истории Telegram и промежуточным очередям; публичный `web/lib/telegram-reviewed.generated.json` остаётся в publish set. Credential-директории `.ssh`, `.aws`, `.azure`, `.kube` и `.gnupg` также исключаются по точному имени. Существующие правила кэшей, env-файлов и маркеров ключей сохраняются.

```sh
python3 -m unittest discover -s tools/github-publish -p 'test_*.py' -v
```

Регрессия создаёт синтетический source snapshot и реальные text-tree payloads: закрытые canary-строки и fake token не попадают в публикацию, а рассмотренный JSON, download manifest, workflow и инструкции сохраняются. Символьная ссылка не может быть использована при извлечении payload. Этот тест не отправляет запросов в GitHub.

## Готовые payloads

В manifest `textTreeChunks` указаны группы уникальных небольших текстовых blobs. JSON тела `{"tree":[...]}` ограничены 400 000 байтами, включая экранирование и пути. Payload не включает owner/repository аргументы обёртки GitHub инструмента.

```sh
python3 tools/github-publish/inventory.py extract \
  --inventory tools/github-publish/generated/inventory.json \
  --kind text-tree --chunk 0 \
  --out tools/github-publish/generated/text-000.json
```

Для каждого SHA из `blobUploads` создаётся один `create_blob` payload. Сюда входят все уникальные binary и большие текстовые файлы, не помещающиеся в text tree chunk. Их содержимое передаётся как base64; это не меняет Git blob SHA декодированных байтов.

```sh
python3 tools/github-publish/inventory.py extract \
  --inventory tools/github-publish/generated/inventory.json \
  --kind blob --sha EXPECTED_GIT_BLOB_SHA \
  --out tools/github-publish/generated/blob.json
```

Окончательное дерево содержит все допустимые пути с `sha`, без повторной передачи содержимого:

```sh
python3 tools/github-publish/inventory.py extract \
  --inventory tools/github-publish/generated/inventory.json \
  --kind final-tree \
  --out tools/github-publish/generated/final-tree.json
```

По умолчанию это полное дерево ровно по локальному publish manifest. Параметр `--base-tree TREE_SHA` сохраняет также существующие пути родительского дерева; он не удаляет старые исключённые файлы. Перед выбором режима владелец публикации должен сверить состав родительского дерева с intended repository scope. `base_tree` принимает SHA дерева, а не parent commit SHA. Родитель commit сохраняется отдельно для `create_commit`.

Во время извлечения contents SHA и размер каждого файла проверяются заново. Если snapshot изменился, extraction останавливается. Можно указать `--source` с новым местом идентичного snapshot. Если изменились файлы релиза, нужно заново запустить inventory.

### Чтение payload ограниченными порциями

```sh
python3 tools/github-publish/inventory.py read-payload \
  --file tools/github-publish/generated/payloads/text-000.json \
  --offset 0 --limit 65536 --stdout
```

Stdout содержит один JSON объект: `text`, `offset`, `bytesRead`, `nextOffset`, `totalBytes`, `end` и `payloadSha256`. `offset` и `limit` измеряются в **исходных UTF-8 байтах**, а не JavaScript символах. Конец порции сокращается до целого UTF-8 символа. Для следующего чтения нужно использовать возвращённый `nextOffset`; конкатенировать значения `text` и после `end: true` один раз разобрать весь payload как JSON. SHA полного payload должен совпадать во всех порциях и с SHA, полученным при extraction.

По умолчанию читается до 65 536 байт; допустим `--limit` до 262 144 байт. Сериализованный ответ может быть больше из-за экранирования текста внутри JSON. Размер вывода `exec_command` должен покрывать этот ответ; при усечённом выводе нельзя отправлять API запрос. Результаты следует собирать непосредственно в памяти вызывающего инструмента, не печатая содержимое или base64 пользователю.

Режим `extract ... --stdout --offset 0 --limit 65536` возвращает такую же ограниченную порцию без записи payload на диск. Для больших файлов эффективнее один раз сделать extraction в `--out`, затем читать готовый payload через `read-payload`.

## Последовательность API вызовов

1. Прочитать текущий ref, commit и tree. Сравнить current head с ожидаемым parent; сохранить полные известные blob SHA для повторного использования.
2. Для каждой text группы вызвать `create_tree` с inline `content`. Это промежуточные деревья, без изменения branch ref. Они материализуют уникальные текстовые blobs; использовать их дерево как окончательный publish tree не следует.
3. Для каждого отсутствующего SHA из `blobUploads` вызвать `create_blob` один раз. Проверить, что возвращённый SHA совпал с ожидаемым. Payload большого файла должен целиком попасть в один вызов; Git blob нельзя собрать из нескольких независимых blob объектов. Если transport требует порций чтения локального файла, объединять их в памяти до API вызова, не выводя base64 пользователю.
4. Создать окончательное дерево из `final-tree.json`, только после успешной загрузки всех referenced blobs. Сверить его paths/modes/SHA с inventory; при recursive read проверить отсутствие `truncated`.
5. Создать commit с `parents: [expectedParentCommit]`. Проверить ref снова и обновить его без `force`. Если head изменился, остановить ref update и согласовать новое основание; не затирать параллельный commit.

Для baseline, проверенного 6 ноября 2026 года, верхняя оценка без уже имеющихся объектов: 33 text tree calls, 252 blob calls и 1 final tree call. Дополнительно требуются read/verification calls, commit и ref update. Это расчёт плана, а не подтверждение совершённой публикации. Git bundle или запуск workflow в качестве канала переноса для этого плана не требуются.

Служебные payloads и инвентаризации находятся в игнорируемом `generated/`. Исторический `SOURCE-INVENTORY.json` внутри исходного freeze может описывать полный архив с raw данными; актуальный состав GitHub публикации определяется новым publish inventory.
