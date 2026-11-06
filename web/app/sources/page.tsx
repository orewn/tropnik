import type {Metadata} from 'next';
import {ContentPage} from '@/components/ContentPage';

export const metadata: Metadata = {
  title: 'Источники и авторы',
  description: 'Откуда берутся маршруты и карты Тропника, как читать дату проверки и что учитывать перед походом. Авторство и открытые лицензии.',
  alternates: {canonical: '/sources'},
};

export default function Sources() {
  return <ContentPage title="Откуда берутся маршруты и карты" kicker="Источники и авторы" lead="В каждой карточке есть ссылка на источник и дата проверки. Они помогают понять, что известно о пути и что нужно уточнить перед выходом.">
    <h2>Как читать карточку маршрута</h2>
    <div className="record-list">
      <article><h3>Описание и параметры</h3><p>Сведения берём у заповедников, национальных парков, официальных туристических организаций и из открытых карт. Длину и время указываем для конкретного варианта пути. Если показатель не подтверждён, оставляем его без значения.</p></article>
      <article><h3>Дата и ограничения</h3><p>Дата проверки показывает, когда мы обращались к источнику. Сообщение о закрытии сохраняется вместе со ссылкой и датой. Погода и правила посещения могут измениться, поэтому перед поездкой нужно свериться с администрацией территории.</p></article>
      <article><h3>Линия на карте</h3><p>Наличие тропы в открытой базе не подтверждает её проходимость, полноту или разрешение на посещение. Справочная карточка помогает изучить маршрут. Для готового похода отдельно проверяют весь путь и условия на местности.</p></article>
    </div>
    <p>Каталог пополняется и пока не охватывает все тропы России. Отсутствие маршрута в Тропнике не означает, что его нет на местности. Указанная сложность и найденное описание не заменяют оценку подготовки участников и условий конкретного выхода.</p>

    <h2>Карта и её покрытие</h2>
    <p>Дороги, тропы, населённые пункты и многие объекты происходят из <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>. Карту дополняют <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> и <a href="https://openfreemap.org/" target="_blank" rel="noreferrer">OpenFreeMap</a>. Выборки пеших маршрутов получены при помощи <a href="https://download.geofabrik.de/russia.html" target="_blank" rel="noreferrer">Geofabrik</a> и <a href="https://hiking.waymarkedtrails.org/" target="_blank" rel="noreferrer">Waymarked Trails</a>.</p>
    <p>Обзорные очертания суши и рельефа предоставлены <a href="https://www.naturalearthdata.com/" target="_blank" rel="noreferrer">Natural Earth</a>, контуры регионов — <a href="https://www.geoboundaries.org/" target="_blank" rel="noreferrer">geoBoundaries</a> на основе данных OpenStreetMap / Wambacher. Контуры отражают состояние источника за 2017 год. Они помогают выбрать направление и не служат актуальным юридическим описанием границ или точной береговой линией. Область показа не определяет правовой статус территорий.</p>
    <p>Сохранённая подробная карта охватывает Бзерпинский район. Дата этого снимка — 1 ноября 2026 года; отдельные исходные сведения могут быть старше. За пределами сохранённого участка для подробной карты может потребоваться интернет. Граница покрытия видна при сохранении.</p>

    <h2>Что показывает рельеф</h2>
    <p>Высоты предоставлены <a href="https://mapterhorn.com/attribution/" target="_blank" rel="noreferrer">Mapterhorn</a>. Для Бзерпинского района используется модель <a href="https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM" target="_blank" rel="noreferrer">Copernicus GLO-30</a> с детализацией около 30 метров. Основная съёмка выполнена в 2011–2015 годах. Дата загрузки карты не означает новую съёмку местности.</p>
    <p>Рельеф помогает увидеть форму склонов. Он может учитывать деревья и сооружения, а мелкие препятствия на тропе не показывает. Цвета и освещение условны. По этой карте нельзя определить текущий снег, состояние переправ, лавинную обстановку или допустимость выхода.</p>

    <h2>Истории о местах</h2>
    <p>Короткие истории опираются на публикации <a href="https://whc.unesco.org/en/list/" target="_blank" rel="noreferrer">Центра Всемирного наследия ЮНЕСКО</a>, <a href="https://www.kavkazzapoved.ru/" target="_blank" rel="noreferrer">Кавказского заповедника</a>, <a href="https://www.ras.ru/" target="_blank" rel="noreferrer">Российской академии наук</a> и других указанных авторов. Прямая ссылка на первоисточник находится в каждой истории.</p>

    <h2>Что сохраняется без сети</h2>
    <p>Сохранённая карточка содержит описание, источник и доступную линию маршрута. Подробную карту и рельеф нужно сохранять отдельно, когда такая возможность предлагается. Перед поездкой откройте раздел «Офлайн» и проверьте, какие материалы действительно есть на этом устройстве.</p>
    <p>Пользовательские отзывы и фотографии других картографических сервисов в эти материалы не переносятся.</p>

    <h2>Авторство и открытые лицензии</h2>
    <p>Тропник сохраняет указание авторов и условия использования исходных материалов. Полные условия использования приведены по ссылкам ниже.</p>
    <details>
      <summary>Авторы карты и условия использования</summary>
      <ul>
        <li><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a> — <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noreferrer">ODbL 1.0</a>.</li>
        <li><a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">© OpenMapTiles</a>, MapTiler.com и участники проекта — оформление CC BY 4.0, программные материалы BSD 3-Clause. <a href="/offline-map/licenses/OpenMapTiles-LICENSE.md">Полный текст лицензии</a>.</li>
        <li><a href="https://openfreemap.org/" target="_blank" rel="noreferrer">OpenFreeMap</a>, © Zsolt Ero — MIT; условия включённых материалов перечислены в <a href="/offline-map/licenses/OpenFreeMap-LICENSE.md">уведомлении об авторстве</a>.</li>
        <li><a href="https://www.naturalearthdata.com/about/terms-of-use/" target="_blank" rel="noreferrer">Natural Earth</a> — общественное достояние.</li>
        <li><a href="https://www.geoboundaries.org/" target="_blank" rel="noreferrer">geoBoundaries</a>, OpenStreetMap / Wambacher — выбранные наборы распространяются по ODbL 1.0.</li>
      </ul>
    </details>
    <details>
      <summary>Авторство рельефа</summary>
      <p lang="en">Terrain © Mapterhorn; produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.</p>
      <p lang="en">The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30.</p>
      <p>При дальнейшем распространении сохраняются эти уведомления и условия <a href="/terrain/sources/Copernicus-GLO30-LICENSE.pdf">лицензии Copernicus GLO-30</a>. Тропник не заявляет об официальном одобрении со стороны названных организаций.</p>
    </details>
    <details>
      <summary>Авторы оформления и картографических компонентов</summary>
      <p>Для Тропника созданы собственные значки интерфейса и категорий. Благодарим авторов открытых шрифтов и картографических компонентов:</p>
      <ul>
        <li>Manrope — © The Manrope Project Authors, <a href="/fonts/MANROPE-LICENSE.txt">SIL Open Font License 1.1</a>.</li>
        <li>Noto Sans — © The Noto Project Authors, <a href="/offline-map/licenses/Noto-Sans-OFL-1.1.txt">SIL Open Font License 1.1</a>.</li>
        <li>MapLibre — © MapLibre contributors, <a href="/maps/MAPLIBRE-LICENSE.txt">лицензия и уведомление об авторстве</a>.</li>
        <li>Leaflet — © Volodymyr Agafonkin и CloudMade, <a href="/maps/LEAFLET-LICENSE.txt">лицензия и уведомление об авторстве</a>.</li>
        <li>Protomaps — © Protomaps LLC, <a href="/maps/PROTOMAPS-LEAFLET-LICENSE.txt">лицензия и уведомление об авторстве</a>.</li>
      </ul>
    </details>
    <div className="section-actions"><a className="button primary" href="/">Вернуться к карте</a><a className="button secondary" href="/offline">Проверить сохранённые материалы</a></div>
  </ContentPage>;
}
