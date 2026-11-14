import {DownloadSimple, ShieldCheck} from './TropnikIcons';
import {Brand} from './Brand';
import {BRAND} from '@/lib/brand';
import styles from './Footer.module.css';

const groups = [
  {
    title: 'Исследовать',
    links: [{label: 'Карта маршрутов', href: '/'}, {label: 'Походы', href: '/trips'}, {label: 'Сообщество', href: '/community'}, {label: 'Гидам', href: '/guides'}],
  },
  {
    title: 'Подготовиться',
    links: [{label: 'Конструктор похода', href: '/planner'}, {label: 'Карты с собой', href: '/offline'}, {label: 'Подготовка к походу', href: '/safety'}, {label: 'Паспорт похода', href: '/safety/registration'}, {label: 'Поиск по сайту', href: '/search'}],
  },
  {
    title: 'О сервисе',
    links: [{label: 'О проекте', href: '/about'}, {label: 'Источники и лицензии', href: '/sources'}, {label: 'Конфиденциальность', href: '/privacy'}, {label: 'Условия использования', href: '/terms'}],
  },
] as const;

export function Footer() {
  return <footer className={`site-footer ${styles.footer}`}>
    <div className={styles.inner}>
      <div className={styles.brandColumn}>
        <Brand small/>
        <p>Выбирайте маршруты по России, готовьтесь к походу и сохраняйте нужные данные, чтобы открыть их без сети.</p>
        <div className={styles.badges} aria-label="Принципы сервиса">
          <span><ShieldCheck size={16}/>Источники и ограничения видны</span>
          <span><DownloadSimple size={16}/>Ключевые данные доступны без сети</span>
        </div>
      </div>
      {groups.map(group => <section className={styles.group} key={group.title}>
        <h2>{group.title}</h2>
        <nav aria-label={group.title}>{group.links.map(({label, href}) => <a href={href} key={href}>{label}</a>)}</nav>
      </section>)}
    </div>
    <div className={styles.bottom}>
      <span><strong>{BRAND.name}</strong> · Сделано для путешествий по России.</span>
      <span>Перед выходом проверяйте актуальные условия и официальные ограничения территории.</span>
    </div>
  </footer>;
}
