#!/usr/bin/env python3
"""Build a transparent, per-relation online-research matrix.

The explicit decisions below were reviewed against primary public sources on
2026-11-06. A website field, search result, or string match never automatically
promotes a route. This script does not change source-only catalog flags.
"""
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import csv
import hashlib
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request

from inspect_source_websites import Text, UA

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'data/catalog'
NOW = datetime.now(timezone.utc).isoformat()
DATE = '2026-11-06'
REVIEW_AT = '2026-11-06T04:58:01.510335+00:00'

# Each tuple records a query actually submitted, and the imported identities it
# was intended to investigate. Grouped queries are bounded discovery attempts,
# not exhaustive searches or evidence of absence.
SEARCHES = [
    ('"В бухту Змеевая" маршрут национальный парк', [5458405]),
    ('"Чёртовы ворота" тропа Байкал официальный маршрут', [16713285]),
    ('"экологическая тропа" "Сукачёва" музей', [21241600]),
    ('"Кивакка" маршрут национальный парк официальный', [18144131]),
    ('site:krasnayapolyanaresort.ru ("Два водопада" OR "Черная пирамида" OR "Перевал Седой" OR "Перевал Аибга") экотропы', [14376574,14376588,14376599,14376615]),
    ('site:rosakhutor.com ("Путь к водопадам" OR "Каменный столб" OR "Юрьев Хутор" OR "Озёрный траверс")', [13232467,13232468,13232469,13232470]),
    ('site:rosakhutor.com ("100 пихт" OR "Лабиринт" OR "Беседка любви" OR "Менделиха")', [16277119,16277120,14376657,14376701,16149624]),
    ('"Монастырская тропа" "Водлозерский" официальный', [18144198]),
    ('"Алла-Аскыр" маршрут официальный Алтай', [8323426]),
    ('"Большая Севастопольская тропа" официальный маршруты', [7051502]),
    ('"Большой Карадаг" маршрут site:karadag.com.ru', [15477153]),
    ('"Чертова лестница" маршрут site:yalta.rk.gov.ru OR site:mtur.rk.gov.ru OR site:travelcrimea.com', [2992836]),
    ('site:paanajarvi-park.com "гора Кивакка"', [18144131]),
    ('site:zapovednoe-podlemorye.ru "Змеиная" маршрут', [5458405]),
    ('"Усадьба Сукачёва" "экологическая тропа" музей -site:trailtrack.ru', [21241600]),
    ('site:karadag.com.ru "Большой Карадаг" "маршрут"', [15477153]),
    ('"Гора Кивакка" "Паанаярви" маршрут официальный сайт', [18144131]),
    ('"Усадьба Сукачёва" "экологическая" тропа музей', [21241600]),
    ('"Тропа здоровья" "Кейву" site:npsochi.ru', [9403239,9403246,10928641,10626407]),
    ('("Два водопада" OR "Два Озера") site:krasnayapolyanaresort.ru/ecotrails', [14376574,14376633]),
    ('("Дантово ущелье" OR "Мальцев" OR "Харгинский лес") маршрут site:gorkluch.ru', [12404970,12404988,13021062]),
    ('("Хмелевские озера" OR "Крепость Ачипсе" OR "Пасть Дракона" OR "Ивановский водопад") site:npsochi.ru', [14378669,14378729,14390331,14390337]),
    ('("Белые скалы" OR "Дзыхринский" OR "Ажек" OR "Дивный лес") site:npsochi.ru', [14397506,14390325,14397458,14901517]),
    ('("Папоротниковая" OR "Плесецкие водопады" OR "Неберджай" OR "семь ветров") экотропа официальный', [16101696,15398162,15418787,15421359,15352276,15352823]),
    ('site:npsochi.ru ("Пасть Дракона" OR "Глубокий Яр") "2026"', [14390331]),
    ('site:rosakhutor.com "пешие маршруты"', [13232467,13232468,13232469,13232470,14378873,16277119,16277120]),
    ('("Поля-Ястребиное" OR "Жёлтый" OR "Красный") "Ястребиное" маршрут официальный', [4509476,4509477,4509478]),
    ('("Ишачья тропа" OR "Красная тропа" OR "Узенбашская тропа" OR "Коровья тропа") Крым официальный', [2978284,2978292,6802600,2993089]),
    ('("Тропа Голицына" OR "Солнечная тропа" OR "Долина привидений") site:travelcrimea.com', [11620035,7455857,12472017]),
    ('("Еврейская тропа" OR "Мисхорская тропа" OR "Кабанья тропа" OR "Ставрикайская тропа") site:zapovedcrimea.ru', [13499262,12347143,12220791,12438965]),
    ('("Романовская дорога" OR "Ангарский перевал" OR "Эклизи-Бурун" OR "Тиссовое ущелье") site:zapovedcrimea.ru', [13407963,12494595,12494851,12494971]),
    ('("Беседка любви" OR "Юрьев Хутор" OR "Озёрный траверс" OR "100 пихт") site:visit.rosakhutor.com', [14376657,13232469,13232470,16277119]),
    ('site:npsochi.ru "Пасть Дракона" "открыт"', [14390331]),
    ('("Виноградный терруар" OR "семи ветров" OR "12 водопадов" OR "На святую Нину") маршрут официальный', [15354460,15352276,15352823,15352408,15355589]),
    ('("Никитино" "Бамбаки" "Тхач") маршрут site:kavkazzapoved.ru', [15922325]),
    ('("Ишачья" OR "Баллы-Коба" OR "Эски-Кермен" OR "Донаторский") маршрут site:travelcrimea.com', [2978284,2981758,2981768,2986430,2986482,2986483]),
    ('site:npsochi.ru ("Девичьи слезы" OR "водопад Безымянный" OR "Краснополянские дольмены")', [14378779,14378808,14378740]),
    ('("Гора Баллы-Коба" OR "Пятая балка" OR "Адым-Чокракская" OR "Мангуп-Кале") маршрут site:travelcrimea.com', [2981758,2981768,2981764,2985053]),
    ('("Ай-Димитрий" OR "Чайный домик" OR "Сююрю-Кая" OR "водопад Серебряный") маршрут site:travelcrimea.com', [2984740,2984860,2984790,2984809,2984813,2984816]),
    ('("Променад по набережной" OR "смотровую Дюрсо" OR "Круглого озера" OR "Подъем на колдун") маршрут Новороссийск официальный', [15352668,15355460,15389921,15407594]),
    ('("30-ка" OR "Через водопадный") маршрут site:kavkazzapoved.ru', [4509282,4509285]),
    ('("Дорога к зоне" OR "Бор-дол" OR "10 памятников ВОВ" OR "Тропа здоровья") пеший маршрут Краснодарский край официальный', [1842873,13014211,14270035,12406143]),
    ('("водопад Хрустальный" OR "Фермерский" OR "Путь воина" OR "Греческий обзор") маршрут Сочи официальный', [14378644,14378821,14378772,14378738]),
    ('("Ахштырский хребет" OR "озеро Голубое" OR "Красная Поляна" "Аибга") маршрут site:npsochi.ru', [14390321,14390341,14390354]),
    ('("Поликаря" "Купель 960" OR "водопад Коготь" OR "к Водопаду") маршрут Сочи официальный', [14397434,14407510,14407325]),
    ('("На сосновый лес" OR "домик йога" OR "По воде к Водопадам") пеший маршрут Абрау Дюрсо официальный', [15355329,15389861,15421510]),
    ('("По хребту Аибга" OR "Тротуары Псебая") маршрут официальный', [16138449,21465406]),
    ('("Джан-Дере" "Новоульяновка" OR "Можжевеловая тропа" "Оникс" OR "спуск" "Карадагской тропы") маршрут официальный', [2983194,8192676,15477200]),
]


def read_json(name):
    return json.loads((OUT / name).read_text())


def write_json(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def fetch_metadata(url):
    if datetime.now(timezone.utc).date().isoformat()!=DATE:
        raise RuntimeError('This script represents the 2026-11-06 human review. Re-review sources before capturing a later snapshot.')
    row = {'url':url, 'retrievedAt':datetime.now(timezone.utc).isoformat(),
           'sourceBodyRedistributed':False, 'method':'Direct public HTTP source read'}
    try:
        request = urllib.request.Request(url, headers={'User-Agent':UA})
        with urllib.request.urlopen(request, timeout=25) as response:
            body = response.read(3_000_001)
            row.update({'httpStatus':response.status, 'finalUrl':response.url})
        if len(body) > 3_000_000:
            raise ValueError('Response exceeds bounded inspection limit')
        parser = Text(); parser.feed(body.decode('utf-8', errors='replace'))
        row.update({'status':'readable' if sum(map(len,parser.parts))>150 else 'insufficient_readable_content',
                    'sourceBodySha256':hashlib.sha256(body).hexdigest(), 'sourceBodyBytes':len(body),
                    'title':' '.join(' '.join(parser.titles).split()[:20]),
                    'displayedStatusTokens':[s for s in parser.parts if s in ('Закрыта','Открыта')][:1]})
    except Exception as error:
        row.update({'status':'unavailable','error':str(error),'retryOrIdentityChangeUsed':False})
    return row


def main():
    routes = read_json('routes.json')['routes']; by_id = {r['osmId']:r for r in routes}
    evidence = read_json('verification-evidence.json')
    # Rebuild this extension without duplicating earlier generated records.
    evidence['records'] = [r for r in evidence['records'] if not r.get('matrixGenerated')]
    evidence['sources'] = [r for r in evidence['sources'] if not r.get('matrixGenerated')]
    websites = read_json('website-inspection.json')['sources']
    metadata = {s['url']:s for s in websites}
    direct = read_json('raw/official/online-source-reviews.json')['sources']
    metadata.update({s['url']:s for s in direct})
    sochi_meta_path=OUT/'raw/official/sochi-catalog-metadata.json'
    if sochi_meta_path.exists():
        sochi_meta=json.loads(sochi_meta_path.read_text())
        metadata[sochi_meta['url']]={**sochi_meta,'status':'readable'}
    cache_path = OUT / 'raw/official/matrix-source-metadata.json'
    if cache_path.exists():
        metadata.update({s['url']:s for s in json.loads(cache_path.read_text())['sources']})

    decisions = {}
    new_evidence = []

    def decision(ids, status, urls, note, authority, scope, **kwargs):
        if isinstance(ids,int): ids=[ids]
        if isinstance(urls,str): urls=[urls]
        for oid in ids:
            if oid not in by_id: raise ValueError(f'Unknown route {oid}')
            decisions[oid] = {'confirmationStatus':status,'sourceUrls':urls,'summary':note,
                              'authority':authority,'verificationScope':scope,**kwargs}

    def official(oid, url, note, level='official_description', published=None, facts=None, status='unknown', **kwargs):
        authority = ('route_operator' if level.startswith('operator') else
                     'regional_tourism_authority' if level=='official_tourism_publication' else
                     'protected_area_manager')
        scope = ['published_route_description']
        if status != 'unknown':scope.append('published_access_restriction' if status=='guide_required_on_manager_page' else 'operating_status_statement')
        d = dict(confirmationStatus='authoritative_description_found', sourceUrls=[url], summary=note,
                 authority=authority, verificationScope=scope)
        if level=='official_feature_description':
            d.update(confirmationStatus='related_authoritative_source_found',verificationScope=['related_landmark_or_route_section'])
        decisions[oid]=d
        new_evidence.append({'routeId':f'osm-relation-{oid}','osmRelationId':oid,
            'evidenceLevel':level,'sourceUrl':url,'officialDescriptionUrl':url,
            'sourcePublishedAt':published,'effectiveFrom':kwargs.pop('effectiveFrom',None),
            'effectiveTo':None,'operatingStatus':status,'summary':note,
            'verificationScope':d['verificationScope'],'displayScope':kwargs.pop('displayScope','Описание первоисточника; геометрия и проходимость не проверены'),
            'publishedFacts':facts or {}, 'fieldVerified':False,'geometryVerified':False,
            'difficultyVerified':False,'permitSatisfied':False,'navigationReady':False,
            'wholeRouteOpeningConfirmed':False if status.startswith('closed') else None,
            'matrixGenerated':True,**kwargs})

    # Resort pages expose live labels; the first status token is the route header,
    # whereas later tokens can belong to recommendation cards for other routes.
    resort = [
      (11681960,'https://krasnayapolyanaresort.ru/reliktovyij_les',0.9,'Около 30 минут'),
      (14376382,'https://krasnayapolyanaresort.ru/chernichnaya_tropa',19,'Около 9 часов'),
      (14376417,'https://krasnayapolyanaresort.ru/alpijskie_luga',3,'Около 2,5 часов'),
      (13025082,'https://krasnayapolyanaresort.ru/vodopad_polikarya_legkiy',1.1,'Около 1 часа'),
      (13030392,'https://krasnayapolyanaresort.ru/tropa_zdorovya',1.7,'Около 1 часа'),
      (14376599,'https://krasnayapolyanaresort.ru/ecotrails/pereval-sedoj',1.8,'Около 4 часов'),
      (14376615,'https://krasnayapolyanaresort.ru/ecotrails/pereval-aibga',1.5,'Около 2 часов'),
      (14376588,'https://krasnayapolyanaresort.ru/ecotrails/chyornaya-piramida',1,'Около 1 часа'),
      (14376574,'https://krasnayapolyanaresort.ru/ecotrails/dva-vodopada',3.5,'Около 2,5 часов'),
      (16101696,'https://krasnayapolyanaresort.ru/ecotrails/paporotnikovaya',3.6,'Около 1,5 часов'),
    ]
    new_urls=[x[1] for x in resort if x[1] not in metadata]
    for s in ThreadPoolExecutor(max_workers=4).map(fetch_metadata,new_urls): metadata[s['url']]=s
    for oid,url,distance,duration in resort:
        displayed=metadata[url].get('displayedStatusTokens',[])[:1]
        status='closed_on_operator_page' if displayed==['Закрыта'] else 'unknown'
        note=('При прямом чтении 06.11.2026 страница курорта помечает маршрут как закрытый.' if status!='unknown'
              else 'Найдено описание маршрута у оператора; актуальную доступность необходимо уточнить.')
        official(oid,url,note,'operator_page',facts={'publishedDistanceKm':distance,'publishedWalkingTime':duration},status=status,
                 displayedOperatingLabel=displayed[0] if displayed else None,
                 operatingLabel='Статус страницы оператора · просмотрено 06.11.2026',
                 sourceCaution='Дата публикации статуса не указана. Поисковый кеш и страницы-подборки могут расходиться со свежей карточкой. Метка не подтверждает состояние на местности; повторно проверить перед планированием.')
    decision(14376633,'related_authoritative_source_found','https://krasnayapolyanaresort.ru/ecotrails',
             'В OSM название «Два Озера», ref Т17; у оператора №17 называется «Озеро Айсберг». Описание озёр Айсберг и Холодное совпадает по смыслу. Тождество всей нитки не установлено.',
             'route_operator',['candidate_route_identity'],identityConflict=True)

    kavkaz15='https://www.kavkazzapoved.ru/routes/no15-krasnaya-polyana-medoveevka'
    official(14378861,kavkaz15,'Заповедник публикует маршрут №15 «Красная Поляна — Медовеевка». В уведомлении от 26.10.2026 он назван круглогодичным; доступ перед выходом необходимо перепроверить.',
             additionalSourceUrls=['https://www.kavkazzapoved.ru/news/s-27-oktyabrya-zakryvaetsya-chast-letnikh-turisticheskikh-marshrutov'])
    official(14378813,'https://www.kavkazzapoved.ru/routes/no-9-urochische-engelmanovy-polyany-ozero-kardyvach',
             'Описание №9 упоминает радиальный выход к Синеокому озеру. Это подтверждение описанного участка, а не совпадения всей геометрии OSM.', 'official_feature_description')

    for oid,slug,note,distance in [
        (14397488,'agurskiy-vodopad','Национальный парк описывает экологическую тропу Агурского ущелья и водопадов.',6.5),
        (14397491,'orlinye-skaly','Национальный парк публикует экологическую тропу «Орлиные скалы».',5.3),
        (14397458,'azhek','Национальный парк описывает маршрут к водопадам Ажек; соответствие всей линии OSM не установлено.',None),
    ]:
        description_url='https://npsochi.ru/mesta/turisticheskie-obekty-natsparka/'+slug+'/'
        if oid in [14397488,14397491]:
            official(oid,'https://npsochi.ru/mesta/turisticheskie-obekty-natsparka/',
                     'В каталоге национального парка объект закрыт как экологическая тропа; посещение территории указано отдельно как доступное. Это не подтверждает допуск к прохождению всей линии OSM.',
                     level='official_status_page',status='trail_closed_territory_access_separate',
                     facts={'publishedDistanceKm':distance},publishedFactsSourceUrl=description_url,
                     additionalSourceUrls=[description_url],
                     operatingLabel='Статус дирекции · просмотрено 06.11.2026',
                     sourceCaution='Следует различать закрытие оформленной экологической тропы и режим посещения окружающей территории. Перед выходом уточнить разрешённый коридор у национального парка.')
        else:
            official(oid,description_url,note,facts={'publishedDistanceKm':distance} if distance else None)
    official(14378740,'https://npsochi.ru/mesta/turisticheskie-obekty-natsparka/ekologicheskaya-tropa-krasnopolyanskie-dolmeny/',
             'Национальный парк описывает экологическую тропу к Краснополянским дольменам. Опубликованная длина — 530 метров; доступ зависит от снега и метеоусловий.',facts={'publishedDistanceKm':0.53,'publishedSeason':'Бесснежный период; зависит от метеоусловий'})
    for oid in [14378779,14378808]:
        decision(oid,'related_authoritative_source_found',by_id[oid]['sourceWebsite'],
                 'Прочитана страница объекта у национального парка. Наличие объекта не подтверждает полный импортированный маршрут или текущий режим доступа.',
                 'protected_area_manager',['related_landmark_description'])
    official(14397487,'https://npsochi.ru/mesta/turisticheskie-obekty-natsparka/',
             'В каталоге национального парка башня на горе Большой Ахун отмечена как закрытый объект. Это ограничение относится к башне; состояние и режим всего подходного маршрута OSM отдельно не установлены.',
             level='official_feature_description',status='destination_closed_on_manager_page',
             operatingLabel='Объект закрыт по странице дирекции · просмотрено 06.11.2026',
             displayScope='Статус башни; не проверка всего подходного маршрута')
    sochi_notice='https://npsochi.ru/news/turizm-kruglyy-god-no-ne-vezde-i-ne-vsegda/'
    official(14390331,sochi_notice,
             'В уведомлении от 28.05.2026 национальный парк закрыл объект «Глубокий Яр / Пасть Дракона» по причинам безопасности. Новое подтверждение открытия при поиске не найдено.',
             'official_notice',published='2026-05-28',status='closed_in_earlier_notice_reopening_not_established',
             sourceCaution='Это найденное прошлое уведомление, а не свежий осмотр. Оно не доказывает отсутствие более нового распоряжения; до уточнения закрытие нельзя молча считать отменённым.')
    for oid in [10626407,14378669,14376701,16149624]:
        decision(oid,'related_authoritative_source_found',sochi_notice,
                 'Национальный парк упоминает объект в уведомлении 28.05.2026; речь о весенних условиях. Текущая доступность и соответствие всей линии OSM не установлены.',
                 'protected_area_manager',['dated_related_object_notice'])
    decisions[16149624]['sourceUrls'].append('https://visit.rosakhutor.com/ru')
    decisions[16149624]['summary']+=' Курорт также описывает парк Менделиха без датированного подтверждения отмены ограничений.'

    abrau='https://visitabrau.ru/todo/peshie-marshruty/'
    for oid in [15354460,15444795,16121230,16126776,16127081]:
        official(oid,abrau,'Оператор Абрау-Дюрсо публикует одноимённый пеший маршрут в собственном каталоге. Совпадение всей геометрии и текущий доступ не установлены.','operator_description')

    official(18144131,'https://paanajarvi-park.com/marshrut-6-peshij-marshrut-gora-kivakka/',
             'Парк описывает пеший маршрут №6 к Кивакке: 5 км в одну сторону, использование в июне–сентябре. Круговой километраж здесь не выводится автоматически.',
             facts={'publishedDistanceOneWayKm':5,'publishedSeason':'Июнь–сентябрь'},
             sourceCaution='У разных издателей встречаются другие длины и варианты маршрута. Параметры страницы относятся к её собственной нитке, а не автоматически к OSM.')
    official(18144198,'https://vodlozero.ru/news/monastyrskaya-tropa.html',
             'Национальный парк в публикации 25.09.2026 описывает состоявшийся поход по Монастырской тропе. Это подтверждение существования, не сообщение о текущем открытии.',published='2026-09-25',
             sourceCaution='Публикация описывает участок Варишпельда — Новгуда; полный вариант RuTrail/OSM отдельно не сопоставлен.')

    crimea='https://zapovedcrimea.ru/yaltinskiy-routes'
    for oid in [12438967,12438968,12351763,11820460,13499477]:
        official(oid,crimea,'Дирекция требует для этого маршрута инструктора-проводника, работающего по соответствующему договору с ФГБУ «Заповедный Крым». Разрешение и текущий доступ нужно уточнить отдельно.',
                 'official_access_rule',status='guide_required_on_manager_page',
                 operatingLabel='Условия дирекции · просмотрено 06.11.2026',
                 displayScope='Условие сопровождения из страницы дирекции; геометрия и допуск конкретной группы не проверены')
    official(18086558,crimea,'Дирекция публикует маршрут «Тропа Палласа». Наличие описания не подтверждает доступность на дату выхода.',facts={'publishedDistanceKm':4.77,'publishedWalkingTime':'Около 3,5 часов'})
    official(17840964,crimea,'Дирекция публикует маршрут к водопаду Учан-Су. Короткая линия OSM требует отдельного сопоставления с разрешённой ниткой.','official_feature_description')
    decision(12438966,'related_authoritative_source_found',crimea,'Дирекция описывает Боткинскую тропу, но самостоятельный импортированный участок «Верхняя Боткинская» отдельно не идентифицирован. Условия сопровождения требуют проверки.',
             'protected_area_manager',['related_route_description'])
    official(2992836,'https://travelcrimea.com/novosti/20261006/4250948.html',
             'Официальный туристический портал перечисляет «Чёртову лестницу» среди маршрутов, открытых по сообщению дирекции 06.10.2026. Это историческое сообщение; актуальный доступ требует проверки.',
             'official_tourism_publication',published='2026-10-06',
             additionalSourceUrls=['https://bst-sev.ru/content/pereval-shaytan-merdven-chertova-lestnica'])
    for oid in [7455857,11620035]:
        official(oid,'https://travelcrimea.com/spa/20200519/1443336.html',
                 'Официальный туристический портал описывает эту тропу. Публикация 2020 года подтверждает известность названия, но не текущие условия или соответствие всей нитки OSM.',
                 'official_tourism_publication',published='2020-05-19')

    # Primary publishers can corroborate their own trails and projects, but do
    # not substitute for the protected-area manager or a current access permit.
    for oid in [7971235,10716769,12328003,18673170,18197119,18197120,18197367,18197451]:
        decision(oid,'publisher_description_found',by_id[oid]['sourceWebsite'],
                 'Издатель маршрута публикует одноимённое описание. Полномочия разрешать доступ, актуальные ограничения и совпадение геометрии не подтверждены.',
                 'trail_publisher',['publisher_route_description'])
    decision(12350723,'related_publisher_source_found',by_id[12350723]['sourceWebsite'],
             'Ссылка ведёт на более широкий маршрут «Индюк, Семашхо, Два брата». Совпадение импортированного отрезка со всем описанием не установлено.',
             'trail_publisher',['related_publisher_description'])
    decision(5458405,'publisher_description_found','https://greatbaikaltrail.org/monahovo-buhta-zmeevaya',
             'Проект Большой Байкальской тропы описывает путь Монахово — бухта Змеевая и сообщает о прекращении собственного обслуживания с 2023 года. Текущие условия и вариант OSM не сверены.',
             'trail_builder_publisher',['publisher_route_description'])
    for oid in [14594896,18162201,5461727,15004011]:
        decision(oid,'project_reference_found',by_id[oid]['sourceWebsite'],
                 'Прочитан сайт проекта протяжённой тропы/сети. Эта запись не равна одному готовому походу; состав участков, разрешения и доступность проверяются отдельно.',
                 'trail_project',['project_existence'],semanticType='route_network_or_long_distance_project')
    decision(7051502,'project_reference_found','https://bst-sev.ru/content/about-project',
             'Сайт проекта описывает Большую Севастопольскую тропу и её этапы. Прямое чтение главной страницы дало 503; описание доступно в веб-индексе. Доступность всех участков не подтверждена.',
             'trail_project',['project_existence'],semanticType='route_network_or_long_distance_project')
    decision(6040458,'secondary_source_only',by_id[6040458]['sourceWebsite'],
             'В OSM приложена энциклопедическая статья об историческом маршруте №77. Первичный актуальный оператор маршрута не установлен.',
             'secondary_encyclopedia',['historical_secondary_description'])
    decision(15477153,'related_authoritative_source_found','http://karadag.com.ru/contacts',
             'Прочитаны контакты научной станции. В индексируемых изданиях станции встречается название «Большой Карадаг», но современная карточка и режим этого маршрута не установлены.',
             'scientific_institution',['related_institution_and_historical_publication'])
    for oid in [4509476,4509477,4509478]:
        decision(oid,'related_authoritative_source_found','https://ooptlo.ru/tropa-ozero-yastrebinoe.html',
                 'Дирекция описывает экотропу «Озеро Ястребиное». Точное соответствие импортированным цветным/подходным маршрутам не установлено; геометрии могут проходить границу Карелии и Ленинградской области.',
                 'protected_area_manager',['related_local_trail'])
    decision(13232468,'related_authoritative_source_found','https://visit.rosakhutor.com/resort-info/schedule',
             'Оператор курорта упоминает пеший выход к Каменному Столбу. Полная идентичность OSM-маршрута и текущий доступ не установлены.',
             'route_operator',['related_hiking_destination'])
    decision(14378873,'related_authoritative_source_found','https://visit.rosakhutor.com/ru',
             'Оператор описывает кемпинг Нахазо. Это не подтверждение конкретного пешего пути от Розы Хутор до кемпинга.',
             'route_operator',['related_destination'])
    decision(15922325,'related_authoritative_source_found',
             'https://www.kavkazzapoved.ru/news/pochti-nedelyu-v-obkhode-gosinspektory-i-opergruppa-kavkazskogo-zapovednika-proveli-sovmestnyy',
             'Сообщение заповедника описывает закрытые для посещения территории в районе Бамбаки/Ачешбок. Совпадение с этой ниткой не установлено: нужна проверка пересечения границ и разрешённого коридора.',
             'protected_area_manager',['related_area_access_warning'])
    decision(4509282,'related_authoritative_source_found',
             'https://www.kavkazzapoved.ru/news/s-27-oktyabrya-zakryvaetsya-chast-letnikh-turisticheskikh-marshrutov',
             'Короткое название «30-ка» соотносится с семейством маршрутов №30. С 27.10.2026 варианты 30В/30Г закрыты, 30А/30Б ограничены дневным участком. Тождество OSM конкретному варианту не установлено.',
             'protected_area_manager',['route_family_operating_notice'],identityConflict=True)
    decision(4509285,'related_authoritative_source_found',
             'https://www.kavkazzapoved.ru/routes/request/80',
             'В форме заповедника описан маршрут №2 через приют Водопадный. Найдено близкое описание, но полная идентичность линии OSM и действующий режим не установлены. Наличие формы заявки не означает открытие маршрута.',
             'protected_area_manager',['candidate_route_identity'])

    # Fetch metadata for new reviewed sources once, retaining no full articles.
    all_urls={u for d in decisions.values() for u in d['sourceUrls']}
    all_urls.update(e['sourceUrl'] for e in new_evidence)
    missing=sorted(u for u in all_urls if urllib.parse.urldefrag(u)[0] not in metadata)
    for s in ThreadPoolExecutor(max_workers=4).map(fetch_metadata,missing):
        metadata[s['url']]=s
    write_json('raw/official/matrix-source-metadata.json',{'createdAt':NOW,'sources':[metadata[u] for u in sorted(all_urls) if u in metadata]})

    sources_added=set()
    for e in new_evidence:
        m=metadata.get(e['sourceUrl'],{})
        checked=m.get('retrievedAt',m.get('checkedAt',REVIEW_AT))
        e['checkedAt']=checked
        e['recheckAfter']=(datetime.fromisoformat(checked)+timedelta(hours=24)).isoformat()
        e['recheckPolicy']='Internal review deadline, not an assurance of unchanged conditions. Expiry never cancels a closure.'
        e['operatingStatusAsOf']=e['sourcePublishedAt'] or checked[:10]
        source_id='review-'+hashlib.sha256(e['sourceUrl'].encode()).hexdigest()[:16]
        e['sourceId']=source_id
        if source_id not in sources_added:
            evidence['sources'].append({'id':source_id,'url':e['sourceUrl'],
              'publisherAuthority':decisions[e['osmRelationId']]['authority'],
              'publishedAt':e['sourcePublishedAt'],'retrievedAt':checked,
              'sourceBodySha256':m.get('sourceBodySha256',m.get('bodySha256')),
              'sourceBodyBytes':m.get('sourceBodyBytes',m.get('bodyBytes')),
              'directReadStatus':m.get('status'), 'sourceBodyRedistributed':False,
              'scope':'Manually scoped online source evidence; no field, geometry, permit, guide or present-safety certification.',
              'matrixGenerated':True})
            sources_added.add(source_id)
        evidence['records'].append(e)
    evidence['checkedAt']=REVIEW_AT
    write_json('verification-evidence.json',evidence)

    evidence_by_id={e['osmRelationId']:e for e in evidence['records']}
    search_records=[{'id':f'q{i+1:02d}','query':q,'checkedDate':DATE,
                     'routeIds':[f'osm-relation-{oid}' for oid in ids],
                     'method':'Bounded web search; grouped terms are discovery attempts, not an exhaustive review.'}
                    for i,(q,ids) in enumerate(SEARCHES)]
    queries_by_id=defaultdict(list)
    for s in search_records:
        for oid in s['routeIds']:queries_by_id[oid].append(s['id'])
    website_by_id={oid:s for s in websites for oid in s['routeIds']}
    matrix=[]
    for route in routes:
        oid=route['osmId']; rid=route['id']; name=route.get('name')
        if route['title'].startswith('Маршрут OSM '):identity='unnamed'
        elif not name or re.fullmatch(r'(?:\d+|[A-Z]{1,3}\d*|Маршрут № \d+)',route['title']):identity='reference_only'
        else:identity='named'
        inspection=website_by_id.get(rid)
        d=decisions.get(oid)
        if not d and oid in evidence_by_id:
            e=evidence_by_id[oid]
            d={'confirmationStatus':'authoritative_description_found','sourceUrls':[e.get('officialDescriptionUrl',e['sourceUrl']),e['sourceUrl']],
               'summary':e['summary'],'authority':'protected_area_manager','verificationScope':e['verificationScope']}
        attempted=bool(inspection or queries_by_id[rid] or d)
        if d: status=d['confirmationStatus']
        elif identity=='unnamed':status='unnamed_identity_unresolved'
        elif attempted:status='no_authoritative_confirmation_found'
        elif identity=='reference_only':status='reference_identity_not_researched'
        else:status='not_researched'
        matrix.append({'routeId':rid,'osmRelationId':oid,'title':route['title'],'regionIds':route['regionIds'],
          'identityStatus':identity,'confirmationStatus':status,
          'researchStatus':'attempted' if attempted else 'not_researched',
          'checkedAt':REVIEW_AT if attempted else None,
          'suppliedWebsite':route.get('sourceWebsite'),'suppliedOperator':route.get('sourceOperator'),
          'websiteInspection':({'url':inspection['url'],'status':inspection['status'],'checkedAt':inspection['checkedAt']} if inspection else None),
          'searchQueryIds':queries_by_id[rid],'sourceUrls':(d or {}).get('sourceUrls',[]),
          'authority':(d or {}).get('authority'),'verificationScope':(d or {}).get('verificationScope',[]),
          'summary':(d or {}).get('summary','По выполненному ограниченному поиску первичное подтверждение не установлено.' if attempted else 'Отдельное исследование первоисточника для этой записи ещё не выполнено.'),
          'semanticType':(d or {}).get('semanticType','event_course' if route['title'].startswith('Riekkalansaari Trail') else 'route_relation'),
          'identityConflict':(d or {}).get('identityConflict',False),
          'evidenceRecordId':rid if oid in evidence_by_id else None,
          'currentOpeningVerified':False,'geometryVerified':False,'fieldVerified':False,
          'navigationReady':False,'permitSatisfied':False,'publicationStatus':'reference','indexable':False})
    summary={'routeCount':len(matrix),'confirmationStatusCounts':dict(Counter(x['confirmationStatus'] for x in matrix)),
             'researchStatusCounts':dict(Counter(x['researchStatus'] for x in matrix)),
             'identityStatusCounts':dict(Counter(x['identityStatus'] for x in matrix)),
             'sourceWebsiteRouteCount':sum(bool(x['suppliedWebsite']) for x in matrix),
             'uniqueSuppliedWebsiteReads':len(websites),'websiteReadStatusCounts':dict(Counter(x['status'] for x in websites)),
             'searchQueryCount':len(search_records),'explicitEvidenceRecords':len(evidence['records']),
             'evidenceLevelCounts':dict(Counter(x['evidenceLevel'] for x in evidence['records'])),
             'geometryVerifiedCount':0,'fieldVerifiedCount':0,'navigationReadyCount':0,
             'byRegion':{reg:dict(Counter(x['confirmationStatus'] for x in matrix if reg in x['regionIds'])) for reg in sorted({g for x in matrix for g in x['regionIds']})}}
    matrix_doc={'schemaVersion':1,'builtAt':NOW,'checkedAt':REVIEW_AT,
      'scope':'Every imported route relation has a research state. Online descriptions and access statements are scoped separately from field or geometry verification. No claim of exhaustive internet coverage.',
      'statusDefinitions':{
        'authoritative_description_found':'Manager, operator or official tourism publisher describes the named route, within the stated scope. Does not establish present access or geometry.',
        'related_authoritative_source_found':'A primary source concerns the place, section, historical restriction or candidate identity. Exact route equivalence is not established.',
        'publisher_description_found':'Primary trail publisher describes its route; land-manager authority and current access are not established.',
        'related_publisher_source_found':'Publisher page describes a wider or related itinerary; exact imported relation is not established.',
        'project_reference_found':'Project/network exists according to its own publisher; the relation is not a single approved trip.',
        'secondary_source_only':'Only a secondary description was reviewed.',
        'no_authoritative_confirmation_found':'A bounded website/search attempt was made; authoritative confirmation was not established. This is not evidence the route does not exist.',
        'not_researched':'No individual source research yet.',
        'unnamed_identity_unresolved':'No usable route name in imported data; no invented identity.',
        'reference_identity_not_researched':'Only a route number/code; not yet linked to an authoritative identity.'},
      'summary':summary,'searches':search_records,'records':matrix}
    write_json('verification-coverage.json',matrix_doc)
    write_json('verification-coverage-summary.json',summary)
    with (OUT/'verification-coverage.csv').open('w',newline='',encoding='utf-8-sig') as f:
        writer=csv.writer(f);writer.writerow(['route_id','title','regions','identity','research','confirmation','scope','sources','field_verified','navigation_ready'])
        for x in matrix:writer.writerow([x['routeId'],x['title'],';'.join(x['regionIds']),x['identityStatus'],x['researchStatus'],x['confirmationStatus'],';'.join(x['verificationScope']),';'.join(x['sourceUrls']),'false','false'])
    old=read_json('import-summary.json');old['officialOnlineEvidenceRecordCount']=len(evidence['records'])
    old['officialOnlineEvidenceMeaning']='Scoped manager/operator/tourism-source descriptions or access statements; see evidenceLevel. Not field, geometry or present-opening verification.'
    old['onlineVerificationCoverage']=summary
    old['integration']['verificationCoverage']='verification-coverage.json'
    old['fileSizesBytes'].update({name:(OUT/name).stat().st_size for name in ['verification-evidence.json','verification-coverage.json','verification-coverage.csv']})
    write_json('import-summary.json',old)
    print(json.dumps(summary,ensure_ascii=False,indent=2))


if __name__=='__main__':main()
