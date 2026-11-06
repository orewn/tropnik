# Yandex hiking directions: source decisions

Reviewed on 2026-11-06. Dataset: `web/lib/yandex-routes.generated.json`.

The [Yandex Travel article](https://travel.yandex.ru/journal/marshruty-dlya-hajkinga-v-rossii/), dated 2024-05-05, is an editorial discovery source. Its seven directions are represented by eight new reference cards and one update of an existing card. Descriptions and parameters come from the primary sources below. No article text, photographs, ratings or claimed bookings were imported.

## Catalogue match and decisions

| Direction | Dataset decision | Primary source and scope |
| --- | --- | --- |
| Divnogorye | `divnogorye-big-divy` | [Museum excursions](https://divnogor.ru/jekskursii/) and [visit information](https://divnogor.ru/visit/). Use the museum's named sights and two-hour guided programme; leave distance unknown. The outdoor section can be visited independently; the cave interior is a guided visit. |
| Cape Tobizina | `primorye-cape-tobizina` | [Primorye tourist information centre](https://visit-primorye.ru/what-to-do/mys-tobizina). 2.5 km/about one hour is explicitly the outward section from Karpinsky Bay. Do not confuse it with the [4–5-hour excursion programme](https://visit-primorye.ru/tours/marshrut-na-mys-tobizina). |
| Multinskiye lakes | `katun-upper-multinskoye` | [Katun Reserve's Upper Lake route](https://katunskiy.ru/posetitelyam/marshrutyi/v-kray-ozer-i-vodopadov). Use its defined six-kilometre route, not the article's broader approximate excursion. [Poperechnoye](https://katunskiy.ru/posetitelyam/marshrutyi/-starinnoy-tropoy-staroverov-) is a separate itinerary. |
| Curonian Spit, Efa Height | `curonian-efa` | [Approved passport, 2025-06-16](https://park-kosa.ru/vyisota-efa.pdf). Choose the full 2.7 km/90-minute itinerary including the sea beach. The [overview page](https://park-kosa.ru/vysota-efa-28ekologicheskaya-tropa29) gives 2.4 km; preserve that distinction in the card rather than average the figures. |
| Yew–boxwood grove | Update `kavkaz-16b`; do not duplicate | The existing [Big Ring](https://www.kavkazzapoved.ru/routes/no16b-tiso-samshitovaya-roscha-bolshoe-kolco) card already matches. Retain its five kilometres and 3–6 hours. Add the editorial mention and [2026-06-17 visitor notice](https://www.kavkazzapoved.ru/news/tiso-samshitovaya-roscha-kak-podgotovitsya-k-progulke-chto-vzyat-s-soboy-i-o-chyom-nuzhno-znat). |
| Krasnoyarsk Stolby, Book of Nature | `stolby-book-of-nature` | [Park description](https://kras-stolby.ru/posetitelyam/marshruty/poznavatelnaya-ekotropa-kniga-prirody-1/). The published 1.2 km and approximately 30 minutes cover one direction. Do not silently include the urban approach or return. |
| Krasnoyarsk Stolby, Takmak/Ermak area | `stolby-takmak-legends` and `stolby-nature-climate` | [Legends of Takmak](https://kras-stolby.ru/posetitelyam/marshruty/marshrut-legendy-takmaka-1/) covers the Ermak area. [Nature and Climate](https://kras-stolby.ru/posetitelyam/marshruty/ekotropa-priroda-i-klimat-1/) is a current viewpoint alternative from the K1 lift. The latter is an editorially selected alternative, not a claim that the article names this exact trail. |
| Great Baikal Trail | `baikal-listvyanka-bolshie-koty` | [Trail creators](https://greatbaikaltrail.org/listvyanka-bol-shie-koty) describe this 24.7 km section. Existing `osm-relation-5461727` represents a much longer, segmented route towards Buguldeyka and must remain distinct. |

## Access and interpretation

- [Stolby route rules](https://kras-stolby.ru/posetitelyam/marshruty/) restrict tourist visits to approved itineraries from 2025-12-01. Do not turn an old mention of Takmak into an unrestricted rock ascent. The three cards carry that dated notice.
- [Katun visitor rules](https://katunskiy.ru/posetitelyam/com_content-article-33) require a permit. They identify the Middle Multinskoye Lake cordon as a permit point. Older announcements describe escorted visits; the card asks visitors to confirm the current arrangement rather than promising unescorted access.
- For Baikal, the park's [2026-09-04 closure notice](https://baikal-1.ru/medvedi-v-natsionalnom-parke-poseshhenie-eshhyo-dvuh-marshrutov-priostanovleno/) is newer than the May fire-closure announcement. A later [September operating list](https://baikal-1.ru/zakryty-eshhyo-neskolko-marshrutov-pribajkalskogo-natsionalnogo-parka/) also excludes BBT. No subsequent reopening was confirmed in the checked official sources; `baikalpass.ru` yielded no readable current status. The card therefore preserves the dated closure, without asserting an independently verified live status.
- Source terms such as “medium”, “non-categorised” and “no special preparation required” stay in `sourceTechnicalDifficulty`; application difficulty remains `unknown`. Reported altitude above sea level and elevation range are not copied into cumulative ascent.

## Geometry and implementation boundaries

The creator links a [GPS archive for Listvyanka–Bolshiye Koty](https://drive.google.com/file/d/1yVIfkSTPdUQtXRuROt78ua659_fAP9FZ/view). The archive was not inspected and is only an external `geometry_download` reference. The [park's full-route page](https://baikal-1.ru/tourism/routes-and-maps/bbt-1-listvyanka-bolshoye-goloustnoye/) also provides a real 2025 GPX for the longer route to Bolshoye Goloustnoye; it is not substituted for this subsection. No GPX licensing or navigation-readiness claim is made.

New cards contain no geometry, geometry URL, bounding box or invented map centre. Sparse points in official passports were not joined into invented paths. `territoryIds` were matched by named administrative territory in `territories.generated.json`; they express source-backed membership, not a new spatial intersection calculation. All new records remain `reference`.

Only the dataset and this decision document were edited for this scope. Root integration owns Trail/SourceReference type extensions, imports, additional region definitions, UI, Android catalogue regeneration and publication.
