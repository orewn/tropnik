import {ContentPage} from '@/components/ContentPage';
import build from 'virtual:pages-build';
export default function AndroidUnavailable() {
  return <ContentPage title="Тропник для Android" kicker="Тестовая версия" lead="Эта публикация содержит веб приложение. Проверенный APK в текущую сборку не включён.">
    <p>Карту и справочные маршруты можно открыть в браузере телефона. Для просмотра без сети сначала сохраните подробный пакет и проверьте его в автономном режиме.</p>
    <p>Ссылка на установку появится после добавления готовой проверенной Android сборки. Эта страница не предлагает неподтверждённую загрузку.</p>
    <div className="section-actions"><a className="button primary" href={build.base}>Открыть карту</a><a className="button secondary" href={`${build.base}offline/`}>Подготовить данные</a></div>
  </ContentPage>;
}
