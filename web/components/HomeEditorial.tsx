import {ArrowRight, DownloadSimple, MapTrifold, ShieldCheck} from '@/components/TropnikIcons';
import {regions} from '@/lib/content';
import {BRAND} from '@/lib/brand';
import {canonicalUrl, homeSeo} from '@/lib/seo';
import {getSeoContext} from '@/lib/seo-metadata';
import styles from './HomeEditorial.module.css';

const serviceCards = [
  {
    icon: MapTrifold,
    label: 'Карта и описание',
    title: 'Понимайте, что известно о маршруте',
    body: 'Смотрите длину, сложность и условия посещения. В карточке указаны источники, даты и подробности о линии пути.',
    href: '/sources',
    action: 'Как устроены источники',
  },
  {
    icon: DownloadSimple,
    label: 'Работа без сети',
    title: 'Сохраните нужное перед выходом',
    body: 'Сохраните карточку и подготовленную карту заранее. Приложение явно показывает, какие данные доступны автономно.',
    href: '/offline',
    action: 'Подготовить офлайн-карту',
  },
  {
    icon: ShieldCheck,
    label: 'Безопасность',
    title: 'Соберите маршрут, состав и сроки',
    body: 'Подготовьте паспорт похода и аварийную карточку. Официальное уведомление МЧС отправляется отдельно на сайте ведомства.',
    href: '/safety/registration',
    action: 'Открыть паспорт похода',
  },
] as const;

const steps = [
  ['01', 'Выберите направление', 'Откройте регион на карте и сравните описания троп, известную длину и сложность.'],
  ['02', 'Проверьте актуальность', 'Перед выходом уточните ограничения территории, погоду, связь и состояние тропы.'],
  ['03', 'Сохраните всё заранее', 'Возьмите офлайн-карту, описание маршрута, контакты и запасной план.'],
  ['04', 'Зафиксируйте план похода', 'Подготовьте состав группы, контрольный срок и сведения для уведомления МЧС.'],
] as const;

export function HomeEditorial() {
  const context = getSeoContext();
  const seo = homeSeo(context, regions);
  const directionLinks = seo.links.filter(item => item.path.split('/')[1] === 'regions');
  return <div className={`${styles.shell} seo-home`}>
    <section className={styles.service} aria-labelledby="service-title">
      <header className={styles.serviceHeader}>
        <div>
          <span className={styles.kicker}>{BRAND.name}</span>
          <h2 id="service-title">Выберите тропу.<br/>Подготовьтесь к походу.</h2>
        </div>
        <p>Пешие маршруты России на одной карте. Изучите описание, проверьте ограничения и сохраните нужные сведения перед выходом.</p>
      </header>
      <div className={styles.serviceGrid}>
        {serviceCards.map(({icon: Icon, label, title, body, href, action}, index) => <article className={styles.serviceCard} key={href}>
          <div className={styles.cardTop}><span className={styles.cardIcon}><Icon size={25}/></span><span className={styles.cardIndex}>0{index + 1}</span></div>
          <span className={styles.cardLabel}>{label}</span>
          <h3>{title}</h3>
          <p>{body}</p>
          <a href={href}>{action}<ArrowRight size={17}/></a>
        </article>)}
      </div>
    </section>

    <section className="seo-tagline" aria-labelledby="tropinych-tagline">
      <span className="eyebrow">От короткой прогулки до большого похода</span>
      <h2 id="tropinych-tagline" className="heading-3">{BRAND.tagline}<br/>Начните с карты России.</h2>
      <p className="body-3">В каталоге собраны маршруты с описаниями, источниками и известными параметрами. Выберите место, которое хочется увидеть.</p>
      <a className="button primary" href={canonicalUrl('/routes/', context)}>Выбрать маршрут <ArrowRight size={18}/></a>
    </section>

    <section className={styles.workflow} aria-labelledby="workflow-title">
      <div className={styles.workflowIntro}>
        <span className={styles.kicker}>От идеи до выхода</span>
        <h2 id="workflow-title">Подготовка начинается<br/>с понятного плана.</h2>
        <p>Выберите маршрут, уточните условия и сохраните карту. Перед выходом договоритесь о составе группы и контрольном сроке.</p>
      </div>
      <ol className={styles.steps}>
        {steps.map(([number, title, body]) => <li key={number}>
          <span>{number}</span>
          <div><h3>{title}</h3><p>{body}</p></div>
        </li>)}
      </ol>
    </section>

    <section className={styles.regions} aria-labelledby="regions-title">
      <header>
        <div><span className={styles.kicker}>Направления России</span><h2 id="regions-title">Куда пойдём<br/>в следующий раз?</h2></div>
        <p>Горные тропы, лесные прогулки и пути вдоль воды. Выберите направление и откройте описания маршрутов.</p>
      </header>
      <nav className={styles.regionGrid} aria-label="Каталог направлений">
        {directionLinks.map((region, index) => <a href={region.url} key={region.url}>
          <span className={styles.regionNumber}>{String(index + 1).padStart(2, '0')}</span>
          <strong>{region.name}</strong>
          <span className={styles.regionArrow}><ArrowRight size={18}/></span>
        </a>)}
      </nav>
      <div className="section-actions"><a className="button secondary" href={canonicalUrl('/routes/', context)}>Каталог маршрутов России <ArrowRight size={18}/></a></div>
    </section>
  </div>;
}
