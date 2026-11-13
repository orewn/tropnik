# Тропник 0.4.33

## Текущий статус

Оптимизация прогрузки была опубликована на сайте из source
`8020e5c3243cd99e6f727e787c3109bece3d28f7`, build `39a9a382cb37a4fb`.
Его полный Pages run 43450247714 и независимые raw32 прошли.
Готовые пары vector/relief и их подписи появляются по мере готовности,
а соседние тайлы разделяют ошибку одного внешнего источника рельефа.
Общий runtime manifest остаётся
`e13c534f6a2fe2b85b59e6cd830376f8e01f965d3d97bebc75e50ad0295e0ded`;
все 61 source input и web/native runtime сохранены.

**Android 0.4.33-preview / code 16 опубликован** из source
`79b5c5edd0c88f7c54e182181c3e8db6791ad706`.
[Собственный run 43466306940](https://github.com/orewn/tropnik/actions/runs/43466306940)
завершил все четыре jobs успешно: 70 JVM, 114 Python tooling, unsigned R8,
11 фактически выполненных device cases и анонимная проверка всех шести
публичных файлов. [Universal APK](https://github.com/orewn/tropnik/releases/download/v0.4.33-preview/tropnik-preview.apk)
имеет 69231946 байт и SHA-256 `1e121dd05d8aba6eeb92640101ea30fdd2764b514c96d6d4924f5b0c34220408`.
[Полный review](verification/android-0.4.33-main.json) и
[неизменённый public producer proof](verification/android-0.4.33-public.json)
связывают source, run, свежий установленный APK, SDK и опубликованные bytes.

Веб-файл `web/public/downloads/android-manifest.json` перенесён целиком
из успешного **universal producer**, без изменения полей: 3177 байт,
SHA-256 `aa01366bcd1917b5353c81a5bbad2a585d745dc757aeecdf57067feb570634c4`.
Публичный release asset с тем же именем описывает ARM64 и для сайта не используется.
После смены веб-манифеста штатные генераторы обновляют только cache VERSION
в `web/public/sw.js`; собственные полные Pages и проверка публичного адреса
остаются обязательными. Содержимое окончательного веб-архива берётся из
принятого Pages artifact без пересборки.

Первый запрос выпуска на `f0c489e9` остановился до публикации: полный source
archive имел 150 096 983 байта, на 96 983 больше общего предела 150 000 000.
[Изолированный preflight](verification/android-0.4.33-source-archive-preflight.json)
воспроизвёл исходный отказ и прошёл 37/37 tests на исправлении. Предел
200 000 000 применяется только к точному source archive проверенной версии;
предел APK и прочих файлов остаётся 150 000 000. Полный архив выпуска
имеет 150 134 059 байт и SHA-256
`d5b2aa0ce856c2ca3986d85c9a95691b458b0e60879ac0a713219abc3c15cc26`.
Это те же bytes, что в preflight и в публичной проверке.

Отдельный Pages run 43458536389 на `f0c489e9` остаётся **FAIL**:
[полные raw objects](verification/web-0.4.33-f0c4-raw-smoothness-failure.json) и
[независимый пересчёт](verification/web-0.4.33-f0c4-raw-smoothness-failure-review.json)
подтвердили 31 прошедшее окно и единственный full desktop pan p95 ровно
35 ms при строгом условии меньше 35 ms. Округление, допуск или повтор
измерения для этого source не применялись. Эти интервалы не устанавливают
причину на уровне функций CPU. Исправление упаковки было подготовлено
независимо; каждый следующий веб-source проходит собственный исходный gate.

Preview подписан development/debug ключом. Сертификат отличается от 0.4.32,
поэтому требования совместимого update-install не выполнены. Проверка
эмулятора API 35 x86_64 не подтверждает физический ARM64, полевой GPS,
батарею или production signing. Подробная автономная карта по-прежнему
ограничена подготовленным пилотным районом. Ручная проверка старой
пользовательской вкладки не заявляется.

## Один жест и два выбора

Полный [Pages run 43418601893](https://github.com/orewn/tropnik/actions/runs/43418601893)
проделал обычный путь через Алтай, маршрут, возврат, Байкал, соседнюю
административную территорию, масштабирование, перемещение и поворот экрана.
В landscape 915×412 реальное касание открытой Canvas должно было выбрать
Иркутскую область. `pointerdown` и `pointerup` пришли в Canvas; обработчик
правильно выбрал область. Затем native `click` того же pointerId 73 пришёл
в маркер Байкала, который уже переместился под отпущенную точку, и заменил
правильный выбор. Оба перехода присутствуют в браузерной истории.

[Source-bound witness](verification/web-0.4.32-pages-failure.json) сохраняет
исходные события, историю, размеры экрана и hashes failure artifacts.
Точку и ожидаемую административную территорию в `polygonTouch` менять не нужно.
Защита должна сохранять настоящее нажатие на маркер мышью или пальцем,
его подпись и счётчик, активацию с клавиатуры и следующий самостоятельный жест.

Защита реализована в общем `CustomMapEngine`: pointer click маркера проверяет
исходную кнопку собственного нажатия и расходует эту запись. PointerId
сравнивается, когда браузер сообщает непустой pointerType.
Новое нажатие в документе, отмена, потеря фокуса, скрытие, удаление маркера
или уничтожение движка сбрасывают её. Keyboard/assistive `detail: 0` и
старые MouseEvent clicks без pointerId сохраняются. Обработчики не отменяют
события и не скрывают их от capture/bubbling наблюдателей документа.

[Регрессионная проверка](verification/web-0.4.33-marker-origin-regression.json):
все пять новых сценариев дают ожидаемые assertion failures на точных bytes
прежнего b80e engine и проходят на исправлении с тем же test file. Полный
engine suite — 71/71, TypeScript — PASS; независимый review не нашёл блокеров.
Это локальный replay зафиксированных браузерных событий. Последующий
реальный Pages run `43422618701` подтвердил исправление: после native zoom,
pan и поворота телефона выбрана Иркутская область. Полный run остановился
позже на отдельном coast witness; deploy пропущен.

Общий runtime первого кандидата регенерирован для web и Android из 61 исходного файла:
12 выходных файлов, 1746 ресурсных aliases. Manifest SHA-256:
`3831d1cbd52aab9c7805b89586fbea33c49d011014181ef8840a81b2483d061d`;
source input set SHA-256:
`4f6ee5671c8cea6f29bbccacc1a4c8328665357dcecee9daf69e43466f07720c`.

## Локальная подготовка первого кандидата

[Preflight](verification/local-0.4.33-preflight.json) фиксирует сборку
`84de743e18910362`, 718 страниц и повторную сверку всех 2161 input hashes.
365 Pages tooling tests, ESLint и TypeScript прошли. Отдельный
[native preflight](verification/android-0.4.33-local-preflight.json)
подтвердил 105 Python, 28 map-tooling и 4 catalogue tests, воспроизводимость
общего runtime и совпадение web/Android outputs.

Первый локальный прогон правильно отклонил неполную генерацию: ресурсный
список SW ещё ссылался на удалённый chunk прежнего runtime. Ошибка устранена
штатными `prepare-offline.mjs` и `stamp-service-worker.mjs`; последующие
32 offline/SW и 9 map-shell tests прошли, итоговая статическая сборка успешна.
Вне generated resources и VERSION поведение SW не менялось. Первые 11
отказов сохранены в preflight; они не переименованы в полный успешный прогон.
Полный suite точного нового source, реальный браузер и APK проверяются в CI.

## Результаты первого CI 0.4.33

[Pages receipt](verification/web-0.4.33-first-validation.json) относится только
к source `5fefc0da294400bf36110c9ee8130e68e7425071`, build `84de743e18910362`
и run `43422618701`. Исправленный выбор после поворота и отдельный SW gate
прошли, но full browser отказал на центрировании береговой точки Gogland.
Все 12 настоящих pan-команд правильно двигали камеру. Старый witness подряд
делал шесть zoom-команд относительно свободной области, накапливая смещение
`(1764, 2898)` px; его исправление потребовало бы 13 коррекций при лимите 12.
После 12 оставалось `64.62256` px при допустимых 6.
[Raw cause](verification/web-0.4.33-coast-cause.json) сохраняет каждую команду
и фактическое смещение. [Исправленный witness](verification/web-0.4.33-coast-navigation.json)
центрирует источник настоящим pan между zoom steps: один общий лимит 12,
те же 28 zoom attempts, координаты, маска и точность 6 px. Production camera
не менялась. Детерминированная регрессия проходит за шесть zoom и шесть
коррекций; подтверждение полным браузером ещё требуется.

[Независимый пересчёт плавности первого кандидата](verification/web-0.4.33-first-smoothness-review.json)
подтвердил 24 фактически завершённых окна с прежними порогами: 16 ранних
и 8 Android в полном сценарии. Ранний map-pan p95: Android 23.9 ms,
desktop 30.6 ms; полный Android — 24.0 ms. Полного desktop результата
после coast failure нет. Это source-bound измерение `5fefc0da`, а не
результат текущей оптимизации загрузки; отсутствующие окна не объявлены PASS.

[Android run `43422618671`](verification/android-0.4.33-first-validation.json)
прошёл build, 70 JVM и unsigned R8, но точный universal APK дал 9 PASS и
2 FAIL из 11 device scenarios. Publish и public jobs пропущены.
[Реальный WebView ledger](verification/android-0.4.33-webview-pointer-failure.json)
показывает собственные trusted pointerdown/up маркера с id 2 и последующий
trusted click с id 3 при пустом pointerType. Строгое сравнение этих id
отвергало правильное нажатие. Исправление сохраняет проверку исходной
кнопки и одноразовое потребление жеста; строгий id остаётся для известного
pointerType. События Canvas по-прежнему не могут активировать переместившийся
маркер. Новый точный APK должен пройти все исходные device scenarios.

## Появление окружения при медленной загрузке

Вид на «Лубяной тракт» выявил две независимые задержки. Общий `Promise.all`
скрывал все готовые клетки нового viewport до завершения самого медленного
источника. Кроме того, соседние relief tiles повторно обращались к одному
неудачному DEM halo URL, каждый раз начиная новое ожидание.

[Диагностический replay](verification/map-0.4.33-loading-pipeline-diagnosis.json)
использует настоящий store и pool, но управляемый HTTP/worker clock — это
не измерение скорости провайдера или пользовательского устройства. В нём
21 из 24 пар готовы за 2605 ms, а один недоступный внешний halo запрашивается
трижды и удерживает старый барьер до 47110 ms. Эти числа описывают только
фиксированный сценарий регрессии.

Новый `loadingGround` показывает готовые пары vector/relief текущего zoom
поверх прежнего полного покрытия. Каждая клетка получает свои подписи
вместе с изображением. Незавершённая пара не рисуется; новое поколение
отбрасывает устаревший preview. Canonical ground, готовность всей области,
ошибки и атомарный переход к спутнику сохраняют прежние условия.
Новые сетевые запросы, дополнительный overscan или pin на каждую клетку
не добавлены. Рисование готовых клеток во время загрузки добавляет paint
работу; это не обещание ускорения каждого кадра.

[Шесть новых регрессий](verification/map-0.4.33-progressive-regression.json)
дают шесть assertion failures на точном старом engine `5fefc0da`. Те же
тела тестов побайтно сохранены в итоговом suite и проходят на исправлении;
проверяются WebView events, готовые пары, подписи, ошибка/retry и lifetime.
[Независимый engine review](verification/map-0.4.33-engine-independent-review.json)
подтвердил 78/78 engine tests после устранения найденного cache дефекта:
подписи высот готовой частичной загрузки теперь исчезают при уменьшении
zoom ниже 10 и возвращаются при обратном переходе без ожидания нового tile.
[Lifetime replay](verification/map-0.4.33-engine-lifetime-replay.json) проверяет
удержание использованных bitmap, отсутствие draw закрытых ресурсов,
сохранение готовых клеток при ошибке, retry одного неудачного primary tile,
атомарность спутника и остановку после destroy. Это локальное доказательство
поведения; браузерная плавность и device scenarios проверяются отдельно.

[Store fix](verification/map-0.4.33-failed-source-sharing.json) сохраняет
ошибку источника в ограниченном наборе текущего pin-поколения. Соседи
используют тот же результат вместо последовательных повторных таймаутов.
Новый pin позволяет новую попытку; запоздавшая ошибка прежнего поколения
не загрязняет новое. [Независимая проверка](verification/map-0.4.33-failed-source-independent-review.json)
подтвердила 38/38 focused tests и ограничение памяти. Прежние concurrency,
deadline, качество DEM и retry внутри pool не менялись. Уже готовая частичная
halo bitmap не пересобирается одним same-key retry; unpin и повторное посещение
снова запрашивают источник.

Отдельный новый browser gate открывает реальный маршрут, нажимает обычный
zoom-out и временно удерживает один настоящий внешний DEM halo запрос.
Он должен подтвердить готовые пары до освобождения этого запроса и полное
завершение после него. Ответы, часы и состояние приложения не подменяются.
Локальные replay не заменяют его реальный Chromium результат.

## Подготовка кандидата с оптимизацией загрузки

[Локальный preflight](verification/local-0.4.33-loading-preflight.json)
проверил **971/971** web tests, **387/387** Pages tooling tests, **28/28**
native map tooling tests, ESLint и полный TypeScript. Runtime воспроизводим
из 61 source input; все 12 web/Android файлов побайтно совпадают. Manifest:
`3a630081d3470c050b5d2010c568ff5faa51e1ce550732d4b8473ef33056f9fd`;
source inputs:
`a863fe0f5d2379a4f5ff225341fe4fce5b163bd7f19413d53e785275c27303cb`.

После генерации runtime штатно обновлены offline resources и SW stamp.
Свежая локальная сборка `eea0352868678f26` содержит 718 страниц и прошла
71 HTTP check; все 2165 build inputs повторно сверены с фактическими bytes.
Loading gate подтвердил совпадение своих inputs без запуска Chromium.
У этой локальной сборки `sourceCommit: null`: она не выдаётся за CI artifact
и не используется вместо финального проверенного архива Pages.

Первый отдельный browser run `43427936120` не дошёл до удержания источника:
за четыре секунды начались 44 центральных запроса, из которых 41 завершился,
но внешнее кольцо DEM ещё не запрашивалось.
[Классификация](verification/map-0.4.33-loading-first-fixture.json) и
[независимый разбор](verification/map-0.4.33-loading-first-fixture-review.json)
сохраняют его как ошибку подготовки fixture, не как product RED. Native
camera, URL parser и Fetch interception были правильными.

[Единственная коррекция](verification/map-0.4.33-loading-acquisition-correction.json)
дала подготовке 15 s вместо 4 s. Фактическое удержание по-прежнему ограничено
8 s, progress — 6 s от реального pause; качество, 42 клетки, native input,
пиксельные критерии и production bytes не менялись. После этого исправления
[новый локальный build](verification/local-0.4.33-loading-acquisition-preflight.json)
`ed67ad6cbd56a305` повторно проверил все 2165 inputs и 24 затронутых tooling
tests. Из build inputs изменился только этот setup deadline; прежние
production/runtime, web tests, lint и types остаются привязаны к тем же bytes.

Повторный диагностический [run `43428798267`](https://github.com/orewn/tropnik/actions/runs/43428798267)
на неизменённом production engine `5fefc0da` воспроизвёл ожидаемое отсутствие
промежуточной отрисовки. [Основной receipt](verification/map-0.4.33-loading-baseline-red.json)
и [независимый разбор](verification/map-0.4.33-loading-baseline-red-review.json)
связаны с source `57bdfd9630a464d7241040ded27b3cba071552fe`, build
`5c78c2796ece628a` и точным artifact digest. Внешний DEM `11/1345/620`
был действительно удержан; камера, маска и overlay стабилизировались.
Последний кадр до release получен через 5976 ms. Полное старое z12 покрытие
не изменилось, промежуточного `loadingGround` не было.

Независимый сетевой расчёт нашёл 17 полностью доставленных neighborhoods
при начале удержания и 29 к последнему кадру; у 19 есть площадь за пределами
старого покрытия. Это завершение vector + 9 DEM HTTP-запросов, **не измерение
готовности декодированных bitmap**. Удержанный запрос не был единственным
незавершённым. Failure PNG снят после release и не подменяет pre-release
свидетельство. Исправленный source ещё должен пройти собственные pixel
comparison, полный Pages и все Android device scenarios.

## Проверка загрузки на source 67d418dd

Кандидат `67d418dd1e187d065d2ff3bd3703c50b7436268b`, build
`ed67ad6cbd56a305`, прошёл новый реальный loading gate в
[Pages run 43429612556](https://github.com/orewn/tropnik/actions/runs/43429612556).
[Независимый pixel receipt](verification/map-0.4.33-loading-green-67d418dd.json)
подтвердил 16 готовых пар из 42 при удержанном внешнем DEM `11/1345/620`.
Подробное покрытие расширилось на 173 061,30 CSS px² за пределами прежней
области. Все 24 пары RGBA совпали между промежуточным и окончательным кадрами;
22 текстурных образца покрывают семь разных клеток. Каждый RGBA-образец
дополнительно сверен с соответствующими пикселями настоящих PNG. После
освобождения запроса приняты полные 42/42 клетки, промежуточный слой очищен.
Девять source hashes и четыре PNG проверены отдельно.

Промежуточный результат получен через 202,468 ms **после перехвата запроса**;
до самого перехвата прошло 8415,651 ms. Эти интервалы не означают полную
загрузку карты за 200 ms. Браузер loading gate штатно остановлен, ошибок
cleanup нет.

Весь Pages run остановился позже на ранней проверке плавности.
[Пересчёт сырых окон](verification/web-0.4.33-loading-smoothness-failure.json)
подтвердил desktop pan p95 **40,9 ms** и zoom **36,0 ms** при прежнем пределе
35 ms. Остальные 14 окон прошли, включая Android pan 21,2 ms и zoom 27,3 ms.
Все 24 длинных интервала desktop pan появились после завершения жеста,
в поздней части окна. Raw timing не содержит синхронной истории loading
paint; связь с конкретной операцией ещё требует отдельного trace.
Chrome и CPU runner отличаются от предыдущего кандидата, поэтому разница
между runs не объявляется чистым сравнением скорости. Полный браузерный
аудит, coast frames и deploy пропущены; принятого Pages payload нет.

На том же source [Android run 43429612598](https://github.com/orewn/tropnik/actions/runs/43429612598)
прошёл **70/70 JVM**, unsigned R8 и **11/11 actual device scenarios**.
[Validation receipt](verification/android-0.4.33-loading-validation.json)
проверяет точный APK, установленный artifact, runtime и исходные протоколы.
[Native marker receipt](verification/android-0.4.33-loading-marker-input.json)
подтверждает успешные реальные WebView 124 gestures с пустым pointerType:
down/up/click `2/2/3`, `4/4/5` и `6/6/7`. Screenshot после касания показывает
Томскую область и Краснодарский край. Publish и public jobs штатно пропущены;
это validation APK, не опубликованная поставка.

Android release request и публичный download manifest остаются на 0.4.32.
Публикация 0.4.33 удерживается до полного Pages PASS исправленного runtime.

## Первая оптимизация кэша: source 90dae23c

Кандидат `90dae23c757c2b630e7f94b6532ef2cda5110562` убрал одну лишнюю операцию: полную копию
canvas для retained ground, пока есть готовые промежуточные пары и их
поколение ещё загружается. Каждая новая пара меняет signature и делает
предыдущую такую копию непригодной для следующего кадра. Прямой onscreen
painter, полный набор loading cells, подписи и очереди загрузки не меняются.
После завершения либо ошибки полезное стабильное покрытие снова сохраняется
при следующей настоящей отрисовке. Таймер или отдельный idle RAF не добавлен.

[Локальный preflight](verification/local-0.4.33-progressive-retain-preflight.json)
проверяет единственное добавление guard в production engine. Новый тест
воспроизводит лишнюю полную копию на exact `67d418dd` и проходит на исправлении.
Он включает три последовательные готовые пары, полное завершение, ошибку
соседа и поздний единственный reject с последующим ленивым сохранением кэша.
Весь engine suite — **79/79**, lint и TypeScript — PASS. Это подсчёт операций
реального engine с управляемыми Canvas и tile delivery, не измерение скорости
браузера. Во время активной загрузки отдельное изменение overlay повторно
использует прямой ground painter; такой сценарий также остаётся в общих gates.

Runtime воспроизводим и побайтно совпадает в 12 web/Android файлах. Manifest:
`d1f8823596d966213e7c0dd68e156ea8feec9d16bda001b42a63e8d0756cbf2a`;
source inputs:
`bba9268d3fd505c58d66c610645d6141634357bac101c06e6df41d7510b0d5d4`.
Локальная сборка `9422286fa73b1574` проверила 718 страниц, 71 HTTP case и
все 2165 input hashes. Её `sourceCommit: null`; браузерные пиксели, реальная
плавность и точный новый APK проверялись отдельно в следующих CI gates.

### Результаты source 90dae23c

[Pages run 43432850110](https://github.com/orewn/tropnik/actions/runs/43432850110)
с build `9422286fa73b1574` снова остановился на ранней плавности:
desktop pan p95 **45,2 ms**, zoom **38,9 ms** при прежнем пределе 35 ms.
Остальные 14 окон прошли; Android pan — 25,9 ms, zoom — 30,9 ms.
[Независимый пересчёт](verification/web-0.4.33-retain-smoothness-failure.json)
сохраняет все 16 завершённых окон без instrumentation. Из 33 длинных pan
интервалов 24 пришлись на позднюю часть после жеста, восемь — на сам drag,
один — на первоначальное settled состояние. Полный UI audit, последующие
pixel gates и deploy не запускались; принятого Pages payload нет.

При этом [loading и SW gates](verification/web-0.4.33-retain-loading-sw.json)
прошли на exact source: при удержанном внешнем DEM готовы 17 из 42 пар,
подробное покрытие расширено на 195 171,45 CSS px². Все 24 raw RGBA пары
совпали между pending и final; все 24 соответствующие PNG crops также
совпали между фазами. В двух сравнениях raw canvas с PNG один и тот же
образец имеет 37 отличающихся пикселей с максимальной channel delta 2;
возможное влияние соседней CSS-тени остаётся объяснением, а не trace proof.
Ни oracle, ни порог не менялись. Progress зафиксирован через 266,35 ms после
реального pause, сам pause — через 6667,01 ms от начала подготовки;
это не полная загрузка за 266 ms. После release приняты 42/42 пары,
все 114 сетевых ответов успешны. SW deadline/retry и cleanup прошли.

[Android run 43432850354](https://github.com/orewn/tropnik/actions/runs/43432850354)
прошёл 70 JVM, unsigned R8 и все 11 exact-artifact device scenarios.
[Validation](verification/android-0.4.33-retain-validation.json) и
[native marker proof](verification/android-0.4.33-retain-marker-input.json)
сохраняют source, runtime, точные APK bytes и настоящие WebView gestures.
Release request остался 0.4.32, publish/public jobs пропущены.

### Trace повторной отрисовки

Один изолированный [diagnostic run 43432849188](https://github.com/orewn/tropnik/actions/runs/43432849188)
с production bytes `67d418dd` сохранил полный native pan trace.
[Trace receipt](verification/map-0.4.33-progressive-paint-trace.json) и
[независимый разбор контекста](verification/map-0.4.33-progressive-trace-independent-review.json)
связывают все 24 поздних RAF interval свыше 50 ms с 24 реальными partial
paint callbacks. В каждом CPU stack присутствуют и `drawTiles → drawImage`,
и `retainGround → drawImage`. Из 5929 CPU samples этих callbacks 3074
относятся к drawTiles, 2328 — к retainGround. Это sample counts,
не доли wall time и не прогноз ускорения.

Геометрия pan: canvas 1041×928, DPR 1, camera zoom 6,1; прежние 64 клетки
z7 и новые 25 клеток z6. Все прежние клетки пересекают viewport. Простого
отсечения невидимых tiles недостаточно; [occlusion model](verification/map-0.4.33-canonical-occlusion-model.json)
также оставляет первые partial frames почти без экономии. [Dirty-region model](verification/map-0.4.33-dirty-region-model.json)
обосновывает обновление ограниченного участка. Модели считают draw calls,
не измеряют native время; фактический порядок завершения клеток не записан.
Zoom trace завершился `Tracing.tracingComplete timed out`, сохранил ноль
байт и не используется для CPU attribution. Run не повторялся и не
подменяет обычные release gates.

## Первый вариант ограниченного обновления: source 7056633b

Кандидат `7056633bddfd2325c4718f385fc55f38ad966459` сохраняет одну совместимую retained surface и при
появлении новых пар обновляет только их целочисленный bounding rectangle
в физических пикселях, с запасом 4 px. Внутри clip воспроизводится прежний
полный ground painter: underlay, canonical и loading пары, рельеф,
границы и полупрозрачная маска в исходном порядке. Исключаются только
тайлы, которые доказанно не влияют на этот clip. Весь foreground рисуется
прежним способом после переноса готовой подложки на видимый canvas.

[Сравнение с историческим painter](verification/map-0.4.33-streamed-ground-painter-factoring.json)
подтверждает совпадение полного ground body после семи явных замен
передачи context/patch, default alpha и объявления scale. Условия, порядок,
константы и whitespace не нормализованы. Foreground совпадает побайтно без
каких-либо замен. Это source proof факторинга; pixel proof clip остаётся
отдельной native проверкой.

Кэш применяется только при совместимых camera/style/source inputs,
stationary north-up view и текущем поколении пар. Смена камеры, размеров,
масштаба экрана, слоя, геометрии, поколения, замена или перестановка старых
bitmap возвращает исходный полный painter. Неизвестная геометрия также
не отсекается. Первое подходящее покрытие сохраняется один раз; полное
canonical завершение перерисовывается целиком. Используется одна прежняя
поверхность с лимитом 32 MiB. Новых запросов, bitmap resampling, таймеров
или idle RAF нет.

[Независимый review движка](verification/map-0.4.33-streamed-ground-independent-review.json)
и [регрессии](verification/map-0.4.33-streamed-ground-regression.json)
проверяют clip, порядок слоёв, identity bitmap, generation, invalidation,
ошибки/retry, foreground и lifetime. Итоговый [локальный preflight](verification/local-0.4.33-streamed-ground-preflight.json)
подтвердил **85/85** engine tests, lint и полный TypeScript. На сохранённой
геометрии и трёх управляемых порядках готовности partial frames выполняют
737, 703 и 726 source-image draw calls вместо 3768. Эти mock counts не
включают full-surface copies, paths и labels и не означают такое же
сокращение времени в браузере.

Runtime воспроизводим из 61 source input; все 12 web/Android файлов
побайтно совпадают. Manifest SHA-256:
`83b26b0121443b963cb7a032dbf3d66d65ff894202dd8b770b95bcf93b7d5c23`;
source inputs:
`d033278ba5e00aea107e617d56d5dcafcf3d4e173e077493a779e7d1458d45cf`.
Локальная сборка `1ea1ee8c41121dd0` прошла 718 страниц, 71 HTTP case и
проверку всех 2165 input hashes. `sourceCommit: null` сохраняется явно;
этот локальный ZIP не используется как поставка.

[Новая native fixture](verification/map-0.4.33-streamed-ground-native-fixture-review.json)
сохраняет прежние 172 pixel frames и deadline и добавляет 198 frames:
trace geometry и lifecycle сценарии при DPR 1, 1,5 и 2. Сравниваются
все RGBA pixels настоящего Canvas с полным painter; допустимая разница —
ноль. Отдельно требуются actual dirty-path hits, bounded clip, один retained
surface, PNG bytes/hash/dimensions и отрицательный контроль пропущенной пары.
Первый запуск выполнен один раз на `verify/streamed-ground-20261113`,
без Pages/APK publication. [Source receipt](verification/source-0.4.33-streamed-ground-diagnostic.json)
связывает exact remote tree с локальным reviewed snapshot; main остался
`90dae23c`.

### Native отказ на границе выбранной территории

[Run 43438213019](https://github.com/orewn/tropnik/actions/runs/43438213019)
прошёл source/parent/request guards и runtime `--check`, но остановился
на `trace-grid / DPR 1 / pair-01`. [Независимый artifact review](verification/map-0.4.33-streamed-ground-native-failure.json)
проверил все 350 сохранённых PNG и заново декодировал RGBA. Прежние
46 + 126 кадров и первые два streaming кадра имеют нулевую разницу.
Первое ограниченное обновление меняет **257 пикселей с max channel delta 1**.
Остальные 195 streaming кадров не исполнены; допуск не изменялся.

[Spatial review](verification/map-0.4.33-streamed-ground-path-failure.json)
помещает все различия внутри clip `[438,316,721,600)`, в полосе
`x711…720 / y317…556` около сглаженного правого `selectedBoundary`.
154 пикселя находятся уже правее нового тайла и в эталоне не менялись
от предыдущего кадра. Это подтверждает дефект повторного рисования
прежней границы под clip. Изоляции stroke/fill отдельным native run не было;
внутренний механизм rasterizer не объявлен доказанным. Actual tile calls
первого обновления — 139 → 36, но эта экономия не компенсирует pixel FAIL.
Cleanup остановил браузер без ошибок; результаты сохранены, run не повторялся.

## Перенос только готовых пикселей в кэш

Исправленный вариант оставляет прежний composed snapshot. `drawGround`
выполняется на видимом context с исходным полным viewport и без Canvas clip.
Ограничение используется только для исключения source tiles, которые не
влияют на dirty rectangle. Все Path2D, включая area под overview, границы
и полупрозрачное выделение, проходят прежнюю rasterization в прежнем порядке.

После этого только готовый целочисленный rectangle копируется из main
canvas в retained surface: одинаковые source/destination coordinates,
identity transform, alpha 1 и операция `copy` внутри destination clip.
Полный сохранённый ground сразу восстанавливается на main, затем рисуется
прежний foreground. Временные пиксели за пределами rectangle восстанавливаются
до завершения того же синхронного draw; отдельного кадра или async gap нет.
Это сохраняет один кэш и прежнее отсутствие ground repaint на stable warm hit.

При исключении snapshot освобождается и выполняется исходный direct painter.
Дополнительно `restoreGround` восстанавливает Canvas state через `finally`,
чтобы ошибка native copy не оставила destructive `copy` перед fallback.
[Независимый source review](verification/map-0.4.33-visible-transfer-source-review.json)
подтверждает, что за пределами `updateLoadingGround` и `restoreGround`
engine побайтно совпадает с проверенным `7056633b`: painter, foreground,
geometry guards, поколение и запросы не менялись.
Целевые 24 incremental frames, все 370 native comparisons с допуском ноль
и прежние budgets остаются обязательными. Исправленный source должен пройти
свой отдельный диагностический run, затем полные Pages и Android gates.
[Fixture review](verification/map-0.4.33-visible-transfer-fixture-review.json)
и [workflow review](verification/map-0.4.33-visible-transfer-workflow-review.json)
проверяют новые наблюдаемые Canvas transfers, отсутствие clip у main paths
и закрытие save/restore scopes. Прежние 172 frames, планы фаз, native runner
и deadline побайтно сохранены; изменены только operation assertions для
новой последовательности копирования и добавлены проверки её точных аргументов.

[Регрессионный receipt](verification/map-0.4.33-visible-transfer-regression.json)
сохраняет expected RED на exact `7056633b` для размещения path painter и
отдельный RED на intermediate `c49bdf…` для утечки `copy` после исключения.
Итоговый [локальный preflight](verification/local-0.4.33-visible-transfer-preflight.json)
подтверждает **88/88** engine tests, engine/test lint и полный TypeScript.
Проверяются частичный перенос, отсутствие clip на main paths, полный restore
перед foreground, ошибки обеих копий, lifetime и прежние invalidations.
Контролируемые source draw counts остались 737/703/726 против 3768;
это количество вызовов, не native ускорение.

Итоговый runtime manifest:
`5fea6c7b878bc50e2efc57e9a01032805f176116bf743e7dc0dff5014ef6b20b`;
source inputs:
`0d89efd6598ff9f70f2f92559d65a2936c2e2e6b1ad0f956e0663c5c534f8cb5`.
Все 12 web/Android outputs побайтно совпадают, deterministic check прошёл.
Локальный build `c627dcc832e505c5` прошёл 718 страниц и 71 HTTP case;
все 2165 input hashes повторно сверены. Его `sourceCommit: null` не
подменяет будущий accepted CI payload.

### Native результат исправленного source 3cb219fd

[Diagnostic run 43440468172](https://github.com/orewn/tropnik/actions/runs/43440468172)
на `3cb219fdd8380fcf2580bfe37aa7d1f47523ba08` завершился SUCCESS.
Это новый исправленный source с parent `7056633b`, а не повтор неудачного
кандидата. [Source receipt](verification/source-0.4.33-visible-transfer-diagnostic.json)
проверяет exact tree и leased fast-forward диагностической ветки.

[Краткий итог](verification/map-0.4.33-visible-transfer-native-summary.json),
[полная проверка изображений](verification/map-0.4.33-visible-transfer-native-success.json)
и [независимый transfer review](verification/map-0.4.33-visible-transfer-native-independent-review.json)
подтверждают **740 декодированных PNG, 370/370 RGBA comparisons с нулевой
разницей**. Все 175 исторических baseline hashes сохранились, включая
первый partial frame; все 174 прежде успешных optimized hashes также
сохранились. Ровно ошибавшийся `pair-01` теперь совпадает с тем же эталоном,
включая все 257 ранее изменённых координат.

Все 72 обязательных incremental frames — 24 при DPR 1, 1,5 и 2 — имеют
полный witness main painter без clip, bounded integer partial capture,
один full restore и сбалансированные context scopes. На каждом DPR эти
24 кадра выполняют 719 source tile calls вместо 3936, плюс 24 partial
captures и 24 full restores. Это native operation counts в controlled
delivery fixture, **не измерение FPS или времени реальной сетевой загрузки**.
Максимальная dirty area — 8,35% backing canvas; используется одна retained
surface. Отрицательный контроль обнаруживает пропущенную вторую пару
при каждом DPR. Все 31 renderer source, 61 runtime input, два manifest
и artifact digest проверены; browser cleanup завершился без ошибок.

[Продвижение на main](verification/source-0.4.33-visible-transfer-main.json)
использует тот же commit, без пересборки или изменения production bytes.
Полный [Pages 43440933324](https://github.com/orewn/tropnik/actions/runs/43440933324)
завершился FAILURE на итоговой performance assertion.
[Независимый пересчёт всех 32 окон](verification/web-0.4.33-visible-transfer-smoothness.json)
подтверждает единственное превышение: полный desktop pan p95 **35,1 ms**
при пределе 35 ms. Ранние 16 и остальные 15 полных окон прошли. Все четыре
audits выполнены при CPU rate 1, с восстановленным throttling и без trace
instrumentation. У полного pan нет long task или интервала выше 50 ms;
девять из двенадцати интервалов от 35 ms пришлись на удерживаемый указатель,
один — на отпускание, два — позже. Эти raw intervals не определяют
конкретную функцию CPU. Принятый browser-verification не создан, deploy
пропущен; source не переименован в успешную поставку. Release request пока
0.4.32. Native pixel PASS не подменяет smoothness или публикацию нового APK.

[Функциональные результаты этого полного run](verification/web-0.4.33-visible-transfer-functional.json)
проверены отдельно: оба native interaction scenarios прошли, после поворота
в обоих профилях выбрана исходная ожидаемая Иркутская область. Все шесть
coast frames каждого профиля готовы, без pending/error, center error не
более 0,000057 px при прежнем пределе 6 px. Close-trail сохраняет исходный
маршрут на z11/14/17; оба satellite continuity scenarios прошли. Hashes
и размеры 69 функциональных PNG подтверждены, 740 native PNG побайтно
совпадают с уже независимо декодированным proof exact source 3cb219fd.

Свежий loading gate показал 17/42 готовых пар при удержанном DEM. Все
24 raw RGBA пары совпали между pending/final; все 21 допустимых PNG crops
из восьми клеток также совпали. Progress — 195,916 ms после настоящего
pause, которому предшествовали 2323,151 ms подготовки; это не обещание
полной загрузки за 196 ms. После освобождения источника покрытие завершилось.
SW update validators и browser cleanup прошли. Эти успешные проверки
не отменяют общий performance failure.

[Android run 43440933260](https://github.com/orewn/tropnik/actions/runs/43440933260)
завершился SUCCESS. [Validation receipt](verification/android-0.4.33-visible-transfer-validation.json)
подтверждает 70 JVM, unsigned R8 и все 11 фактически исполненных device
cases. Установлен свежий universal APK 69 231 946 B с SHA-256
`640be462043ce4f248757ecc1e7e8507902c64aaafc82d5d9ec897083403fed9`;
его runtime, inputs и 1746 aliases совпадают с exact source.
[Native marker evidence](verification/android-0.4.33-visible-transfer-marker-input.json)
сохраняет реальные empty-pointerType WebView gestures и два pixel reports
47/47. Device timings 1100/1243 ms относятся к своим сценариям и не
подменяют browser smoothness. Publish/public jobs фактически SKIPPED
при `release_requested=false`; этот APK не объявляется публичным выпуском.

## Непрозрачные vector tiles

Следующий кандидат меняет только атрибут выходной Canvas в tile worker:
обычный vector tile создаётся с `alpha: false`. Настоящий painter сначала
полностью заполняет его непрозрачным CARTOGRAPHY.land, затем рисует исходную
геометрию. Это справедливо и для пустого MVT, и для целочисленно вырезанного
overzoom child. Canvas может явно учитывать непрозрачность источника при
повторных drawImage. Прозрачные vector overlays, измеренный relief и
декодированные растровые источники сохраняют `alpha: true`.

Количество, zoom, URLs, геометрия, размер 512×512 и порядок рисования тайлов
не меняются. В production изменён только `web/lib/custom-map-tiles.worker.ts`;
engine и renderer paths остаются точными bytes 3cb219fd. Фактическое ускорение
не выводится из одного атрибута и должно пройти собственный native/performance
CI. Уменьшение source zoom не применяется: оно меняло бы набор исходных объектов.

[Регрессионный receipt](verification/map-0.4.33-opaque-vector-regression.json)
подтверждает 26/26 worker tests и lint. На точных bytes worker 3cb219fd новые
ожидания дают три alpha failures при 23 PASS. Контролируемые API проверяют
scope default/false/true, software raster policy, пустой и gzip MVT, native
и overzoom окна, background перед paths, совпадение labels/geometry/crop,
parent reuse и ownership. Эти mock команды не являются native pixel proof.

[Native fixture preflight](verification/map-0.4.33-opaque-vector-native-preflight.json)
и [независимый source review](verification/map-0.4.33-opaque-vector-native-review.json)
закрепляют 48 случаев: реальные source tiles z7/z12/z14, пустой MVT,
overzoom child z18, прозрачные overlays и измеренный relief; DPR 1/1,5/2
и оба raster policies. 96 настоящих Workers должны дать 144 нулевых RGBA
сравнения для tile, плоской и повёрнутой/наклонной проекций, с 288 PNG.
[Source witness](verification/map-0.4.33-opaque-vector-native-sources.json)
сверяет baseline с точным `git show 3cb`, включая все шесть painter dependencies,
engine/camera и четыре исходных файла. Это подготовка строгого gate, пока
не результат настоящего браузера. Прежние Pages gates сохранены; новый
обязательный proof также проверяется по публичному адресу после deployment.

[Локальный preflight opaque candidate](verification/local-0.4.33-opaque-vector-preflight.json)
проверяет build `39a9a382cb37a4fb`: 718 страниц и все 2167 source input hashes,
статический и HTTP gates, 26 worker tests, 13 publication tests, worker lint
и полный TypeScript. Runtime manifest
`e13c534f6a2fe2b85b59e6cd830376f8e01f965d3d97bebc75e50ad0295e0ded`,
source inputs `0025075e39c7cf8a2233867d940066aa635770139b9b6e0f02ae29ffaf5e7642`;
все 12 web/Android outputs совпадают побайтно. SourceCommit локальной
сборки равен null. Принятый CI artifact и native результаты ещё требуются.

## Проверка source 8020e5c3 перед запросом выпуска

Изолированный [run 43449346670](https://github.com/orewn/tropnik/actions/runs/43449346670)
на точном source 8020e5c3 прошёл 48 случаев, 96 настоящих Workers и 144 сравнения
RGBA с нулевой разницей. Все 288 PNG дополнительно декодированы независимо.
Тот же diagnostic run прошёл все 16 исходных uninstrumented smoothness windows.
Desktop pan p95 составил 30,2 ms при строгом лимите меньше 35 ms. Runner был
EPYC 9V74, а предыдущая проверка 3cb — EPYC 7763: это не количественное A/B
измерение ускорения.

После продвижения того же commit в main полный Pages run 43450247714
прошёл существующие функциональные сценарии, проверки SW update, загрузки
при задержанном DEM halo, 370 underlay frames и 144 worker opacity comparisons.
Early/full raw32 пересчитаны отдельно без изменения исходных валидаторов.
Полные исходные audit objects сохранены в
[raw receipt](verification/web-0.4.33-accepted-main-raw.json), а независимый
расчёт — в [smoothness review](verification/web-0.4.33-accepted-main-smoothness-review.json).
[Запись prerequisites](verification/source-0.4.33-release-request.json)
разделяет результаты CI, независимый разбор журналов и недоступную пока
повторную проверку bytes скачанных артефактов.

Runtime manifest остаётся `e13c534f6a2fe2b85b59e6cd830376f8e01f965d3d97bebc75e50ad0295e0ded`,
source inputs — `0025075e39c7cf8a2233867d940066aa635770139b9b6e0f02ae29ffaf5e7642`.
Запрос публикации и release notes не меняют эти 61 вход и общий runtime.

## Порядок выпуска

Сначала исправленный source проходит изолированную native pixel проверку.
После PASS тот же commit с общим runtime и версиями 0.4.33 отправляется на main при
неизменённом `release-request.json` прежнего 0.4.32. Это штатный режим:
Android выполняет build, unsigned production R8 и exact-artifact device gate,
а publish/public jobs пропускаются. Полный Pages использует исходный сценарий,
бюджеты и обязательный SW update gate.

После успешной проверки исправленного runtime отдельное изменение release
request запросит 0.4.33. Его собственный Android run заново выполнит все
обязательные шаги до публикации и анонимной проверки. Только final universal
manifest после public proof будет продвинут в веб-сборку. Результаты разных
source и build не подменяют друг друга.

## Сохраняющиеся условия

Preview использует development/debug подпись; сравнение сертификата с
предыдущей поставкой остаётся обязательным. Совместимое update-install,
физический ARM64, полевой GPS, батарея, живой API и SMTP не подтверждаются
наличием эмуляторного CI. Подробная автономная подложка по-прежнему ограничена
подготовленным пилотным районом. Исходные маршруты и их геометрия не меняются.
