import {ContentPage} from '@/components/ContentPage';
import build from 'virtual:pages-build';
export default function AndroidUnavailable() {
  return <ContentPage title="Тропник для Android" kicker="Карта с собой" lead="Скачать приложение сейчас не получается. Карту и маршруты можно открыть в браузере телефона.">
    <p>Для просмотра без сети сохраните описание маршрута и нужную карту заранее.</p>
    <div className="section-actions"><a className="button primary" href={build.base}>Открыть карту</a><a className="button secondary" href={`${build.base}offline/`}>Мои маршруты</a></div>
  </ContentPage>;
}
