import {ArrowRight, DownloadSimple, MapTrifold, ShieldCheck} from '@/components/TropnikIcons';
import {regions} from '@/lib/content';
import styles from './HomeEditorial.module.css';

const serviceCards = [
  {
    icon: MapTrifold,
    label: 'Проверяемая карта',
    title: 'Понятно, откуда взялись данные',
    body: 'В карточке маршрута остаются источник, дата проверки, ограничения и честная отметка, если точной линии пути пока нет.',
    href: '/sources',
    action: 'Как устроены источники',
  },
  {
    icon: DownloadSimple,
    label: 'Работа без сети',
    title: 'Нужное остаётся с вами в походе',
    body: 'Сохраните карточку и подготовленную карту заранее. Приложение явно показывает, какие данные доступны автономно.',
    href: '/offline',
    action: 'Подготовить офлайн-карту',
  },
  {
    icon: ShieldCheck,
    label: 'Безопасность',
    title: 'Маршрут, состав и сроки в одном паспорте',
    body: 'Помощник собирает данные для официального уведомления МЧС и аварийной карточки, не выдавая локальный черновик за регистрацию.',
    href: '/safety/registration',
    action: 'Открыть паспорт похода',
  },
] as const;

const steps = [
  ['01', 'Выберите направление', 'Сравните реальные условия, сложность, доступность и происхождение данных.'],
  ['02', 'Проверьте актуальность', 'Перед выходом уточните ограничения территории, погоду, связь и состояние тропы.'],
  ['03', 'Сохраните всё заранее', 'Возьмите офлайн-карту, описание маршрута, контакты и запасной план.'],
  ['04', 'Зафиксируйте план похода', 'Подготовьте состав группы, контрольный срок и сведения для уведомления МЧС.'],
] as const;

export function HomeEditorial() {
  return <div className={styles.shell}>
    <section className={styles.service} aria-labelledby="service-title">
      <header className={styles.serviceHeader}>
        <div>
          <span className={styles.kicker}>Тропник как сервис</span>
          <h2 id="service-title">Не просто найти тропу.<br/>Подготовить поход спокойно.</h2>
        </div>
        <p>Карта, проверяемые сведения, автономный доступ и паспорт безопасности собраны в одном последовательном сценарии — без скрытых обещаний и лишнего шума.</p>
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

    <section className={styles.workflow} aria-labelledby="workflow-title">
      <div className={styles.workflowIntro}>
        <span className={styles.kicker}>От идеи до выхода</span>
        <h2 id="workflow-title">Четыре шага вместо десятка разрозненных сервисов.</h2>
        <p>Каждый следующий шаг появляется тогда, когда он действительно нужен. Сначала выбор, затем проверка, сохранение и безопасность.</p>
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
        <div><span className={styles.kicker}>Направления России</span><h2 id="regions-title">Начните с ландшафта, который вам близок.</h2></div>
        <p>Откройте направление, чтобы увидеть доступные маршруты, особенности территории и подготовленные истории мест.</p>
      </header>
      <nav className={styles.regionGrid} aria-label="Каталог направлений">
        {regions.map((region, index) => <a href={`/regions/${region.id}`} key={region.id}>
          <span className={styles.regionNumber}>{String(index + 1).padStart(2, '0')}</span>
          <strong>{region.name}</strong>
          <span className={styles.regionArrow}><ArrowRight size={18}/></span>
        </a>)}
      </nav>
    </section>
  </div>;
}
