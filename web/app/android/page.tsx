import androidBuild from '@/public/downloads/android-manifest.json';
import type {Metadata} from 'next';
import {Header} from '@/components/Header';
import {Footer} from '@/components/Footer';
import {Mountains, ArrowDown, MapTrifold, ShieldCheck} from '@/components/TropnikIcons';

export const metadata: Metadata = {title: 'Тропник для Android', description: 'Карта и сохранённые маршруты на телефоне — даже без интернета.'};
export default function Android() {
  return <><Header active=""/><main id="main">
    <section className="page-hero"><span className="eyebrow">Тропник с собой</span><h1>Связь закончилась.<br/>Карта осталась.</h1><p>Сохраните маршруты на телефоне и возвращайтесь к ним без интернета. Подробная карта Бзерпинского карниза уже внутри приложения.</p></section>
    <div className="page-content"><div className="app-callout"><div><h2>Подготовьте карту<br/>до выхода.</h2><p>Тропы, подписи и рельеф помогают изучить местность. Граница на карте показывает, какой район доступен без сети.</p>
      <a className="button" href={`/downloads/tropnik-arm64-preview.apk?sha256=${androidBuild.sha256}`} download><ArrowDown size={18}/>Скачать для Android · {new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 1}).format(androidBuild.bytes / 1024 ** 2)} МБ</a>
      {androidBuild.compatibleWithPreviousPreview === false && <div className="inline-note" role="note" style={{marginTop: 12}}>Этот файл не подходит для обновления ранее установленного Тропника. Не удаляйте прежнее приложение, если в нём есть нужные данные.</div>}
      <p className="fineprint" style={{marginTop: 12}}>Для телефонов с Android 8.0 и новее. После установки откройте карту и убедитесь, что нужный участок доступен без интернета.</p>
    </div><div className="phone-silhouette" aria-hidden="true"><Mountains size={73}/><span><MapTrifold size={21}/>Бзерпинский карниз</span></div></div>
      <div className="prose-grid">
        <article className="prose-card"><MapTrifold size={29}/><h3>Нужный участок под рукой</h3><p>Подробная карта охватывает район Бзерпинского карниза. Для других направлений заранее проверьте доступное покрытие.</p></article>
        <article className="prose-card"><ShieldCheck size={29}/><h3>Дата и источник рядом</h3><p>Сохранённые сведения остаются с вами. Перед каждым походом проверяйте свежие ограничения и условия посещения.</p></article>
        <article className="prose-card"><Mountains size={29}/><h3>Планируйте свой путь</h3><p>Сравнивайте маршруты, учитывайте свою подготовку и уточняйте условия посещения.</p></article>
      </div>
    </div>
  </main><Footer/></>;
}
