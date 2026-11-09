import {DownloadSimple, ShieldCheck} from './TropnikIcons';
import {Brand} from './Brand';
import styles from './Footer.module.css';

const groups = [
  {
    title: 'Исследовать',
    links: [['Карта маршрутов', '/'], ['Походы', '/trips'], ['Сообщество', '/community'], ['Гидам', '/guides']],
  },
  {
    title: 'Подготовиться',
    links: [['Конструктор похода', '/planner'], ['Карты с собой', '/offline'], ['Подготовка к походу', '/safety'], ['Паспорт похода', '/safety/registration'], ['Поиск по сайту', '/search']],
  },
  {
    title: 'О сервисе',
    links: [['О проекте', '/about'], ['Источники и лицензии', '/sources'], ['Конфиденциальность', '/privacy'], ['Условия использования', '/terms']],
  },
] as const;

export function Footer() {
  return <footer className={`site-footer ${styles.footer}`}>
    <div className={styles.inner}>
      <div className={styles.brandColumn}>
        <Brand small/>
        <p>Маршруты России, подготовка к походу и нужные данные офлайн — в одном спокойном и проверяемом сценарии.</p>
        <div className={styles.badges} aria-label="Принципы сервиса">
          <span><ShieldCheck size={16}/>Источники и ограничения видны</span>
          <span><DownloadSimple size={16}/>Ключевые данные доступны без сети</span>
        </div>
      </div>
      {groups.map(group => <section className={styles.group} key={group.title}>
        <h2>{group.title}</h2>
        <nav aria-label={group.title}>{group.links.map(([label, href]) => <a href={href} key={href}>{label}</a>)}</nav>
      </section>)}
    </div>
    <div className={styles.bottom}>
      <span><strong>Тропник</strong> · Сделано для путешествий по России.</span>
      <span>Перед выходом проверяйте актуальные условия и официальные ограничения территории.</span>
    </div>
  </footer>;
}
